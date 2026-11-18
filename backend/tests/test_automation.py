import asyncio
import datetime as dt
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from test_discovery import database, mock_duckduckgo, HTML
from agents.supplier_discovery import providers, scheduling, storage, workflow
from agents.supplier_discovery.extraction import extract
from main import app


def account(renewal='2026-12-17', usage=3, remaining=247, status='Active'):
    return {'account_status': status, 'plan_renewal_date': renewal, 'this_month_usage': usage,
            'plan_searches_left': remaining, 'total_searches_left': remaining, 'searches_per_month': 250}


def admin():
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    return client


def test_resume_48h_rotation_and_simulated_elapsed_time(database, monkeypatch):
    requests = mock_duckduckgo(monkeypatch)
    client = admin()
    clock = [dt.datetime(2026, 11, 17, 10, tzinfo=dt.timezone.utc)]
    stamp = lambda: clock[0].isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    future = lambda seconds: (clock[0] + dt.timedelta(seconds=seconds)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    for module in (storage, providers, scheduling, workflow):
        monkeypatch.setattr(module, 'now', stamp)
    monkeypatch.setattr(scheduling, 'future', future)
    monkeypatch.setattr(workflow, 'future', future)
    resumed = client.post('/api/v1/discovery/schedule/resume').json()
    assert resumed['enabled'] and resumed['interval_seconds'] == 172800
    assert resumed['next_run_at'] == future(172800)
    assert not [r for r in requests if r.url.path == '/search.json']
    assert asyncio.run(workflow.scheduler_tick()) is None
    with patch.object(workflow, 'permitted_page', return_value=(HTML.replace('manufactures', 'manufactures packaging factory printed'), 'https://fixture.invalid/')):
        for index in range(3):
            clock[0] += dt.timedelta(hours=48)
            job_id = asyncio.run(workflow.scheduler_tick())
            assert job_id
            with storage.connection() as conn:
                job = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()
            assert job['trigger_type'] == 'Scheduled'
            filters = json.loads(job['filters'])
            assert filters['rotation_index'] == index
            assert filters['city'] == scheduling.ROTATION[index]['city']
            assert filters['product'] == scheduling.ROTATION[index]['product']
            assert filters['keywords'] == scheduling.ROTATION[index]['keywords']
            assert scheduling.schedule_status()['next_run_at'] == future(172800)
            assert asyncio.run(workflow.scheduler_tick()) is None
    assert scheduling.schedule_status()['next_criteria']['rotation_index'] == 3
    assert len([r for r in requests if r.url.path == '/search.json']) == 3


def test_billing_renewal_not_calendar_month_resets_budget(database, monkeypatch):
    mock_duckduckgo(monkeypatch)
    monkeypatch.setattr(providers, 'now', lambda: '2026-11-17T00:00:00.000Z')
    providers.store_account(account())
    with storage.connection() as conn:
        ledger = providers.read_ledger(conn)
        ledger['used'] = 20
        providers.write_ledger(conn, ledger)
    key = providers.ledger_key()
    monkeypatch.setattr(providers, 'now', lambda: '2026-12-01T00:00:00.000Z')
    providers.store_account(account())
    assert providers.ledger_key() == key
    assert providers.usage_status()['used'] == 20
    assert providers.usage_status()['paused_reason']
    monkeypatch.setattr(providers, 'now', lambda: '2026-12-18T00:00:00.000Z')
    providers.store_account(account('2027-01-17', 0, 250))
    assert providers.usage_status()['used'] == 0
    assert providers.usage_status()['paused_reason'] is None
    assert providers.usage_status()['cycle_renewal'] == '2027-01-17'


def test_missing_renewal_and_balance_increase_do_not_erase_usage(database, monkeypatch):
    mock_duckduckgo(monkeypatch)
    providers.store_account(account(None))
    with storage.connection() as conn:
        ledger = providers.read_ledger(conn)
        ledger['used'] = 19
        providers.write_ledger(conn, ledger)
    providers.store_account(account(None, 0, 250))
    assert providers.usage_status()['used'] == 19
    providers.store_account(account('2027-01-17', 0, 250))
    assert providers.usage_status()['used'] == 19  # First provider baseline is not a renewal.


def test_legacy_budget_is_conservatively_preserved(database, monkeypatch):
    mock_duckduckgo(monkeypatch)
    key = 'discovery.duckduckgo.' + providers.fingerprint() + '.2026-11'
    value = json.dumps({'used': 4, 'cache': {}, 'last_account': None})
    with storage.connection() as conn:
        conn.execute('INSERT INTO settings VALUES(?,?)', (key, value))
    assert providers.usage_status()['used'] == 4
    providers.store_account(account())
    assert providers.usage_status()['used'] == 4
    with storage.connection() as conn:
        assert conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()[0] == value


def test_shared_budget_stops_automatic_and_manual_searches(database, monkeypatch):
    requests = mock_duckduckgo(monkeypatch)
    monkeypatch.setenv('DISCOVERY_MONTHLY_SEARCH_LIMIT', '2')
    asyncio.run(providers.duckduckgo_search({'product': 'carton'}))
    client = admin()
    assert client.post('/api/v1/discovery/schedule/resume').status_code == 200
    with storage.connection() as conn:
        conn.execute('UPDATE discovery_schedule SET next_run_at=?', (storage.now(),))
    with patch.object(workflow, 'permitted_page', return_value=(HTML, 'https://fixture.invalid/')):
        assert asyncio.run(workflow.scheduler_tick())
    assert providers.usage_status()['used'] == 2
    assert scheduling.schedule_status()['blocked_reason']
    assert client.get('/api/v1/discovery/summary').json()['agent_status'] == 'Paused'
    assert client.post('/api/v1/discovery/schedule/resume').status_code == 422
    with pytest.raises(providers.SearchPaused):
        asyncio.run(providers.duckduckgo_search({'product': 'paper bags'}))
    assert len([r for r in requests if r.url.path == '/search.json']) == 2


def test_weekly_recheck_and_cooldown_by_domain(database, monkeypatch):
    mock_duckduckgo(monkeypatch, body={'organic_results': []})
    data, evidence = extract(HTML, 'https://fixture.invalid/')
    with storage.connection() as conn:
        lead, _ = storage.save_lead(conn, data, 'prior-source', 'Automated Discovery', evidence, url=data['website'])
        six_days = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=6)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        conn.execute('UPDATE discovery_sources SET accessed_at=?', (six_days,))
    assert workflow.recently_researched('https://fixture.invalid/contact', providers.configuration())
    with storage.connection() as conn:
        eight_days = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=8)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        conn.execute('UPDATE discovery_sources SET accessed_at=?', (eight_days,))
    assert not workflow.recently_researched('https://fixture.invalid/contact', providers.configuration())
    id = workflow.create_job({'mode': 'automatic', 'scheduled': True, 'product': 'cardboard', 'city': 'Karachi'}, 'scheduler', trigger='Scheduled')
    with patch.object(workflow, 'permitted_page', return_value=(HTML, data['website'])) as page:
        asyncio.run(workflow.run_job(id))
        assert page.call_count == 1
    with storage.connection() as conn:
        assert conn.execute('SELECT duplicates FROM discovery_jobs WHERE id=?', (id,)).fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 1
        assert conn.execute('SELECT status FROM discovery_leads WHERE id=?', (lead,)).fetchone()[0] == 'Pending Review'


def test_pause_resume_conflict_and_restart_recovery(database, monkeypatch):
    requests = mock_duckduckgo(monkeypatch)
    client = admin()
    first = client.post('/api/v1/discovery/schedule/resume').json()
    queued = workflow.create_job({'mode': 'manual', 'seed_urls': ['https://fixture.invalid/']}, 'manual')
    with storage.connection() as conn:
        conn.execute('UPDATE discovery_schedule SET next_run_at=?', (storage.now(),))
    assert asyncio.run(workflow.scheduler_tick()) is None
    assert client.post('/api/v1/discovery/jobs', json={'mode': 'seeds'}).status_code == 409
    assert client.post('/api/v1/discovery/schedule/pause').json()['next_run_at'] is None
    assert client.get('/api/v1/discovery/jobs/' + str(queued)).json()['status'] == 'Queued'
    resumed = client.post('/api/v1/discovery/schedule/resume').json()
    with TestClient(app) as restarted:
        restarted.cookies.set('cp_session', 'admin-token')
        after = restarted.get('/api/v1/discovery/summary').json()
        assert after['schedule']['next_run_at'] == resumed['next_run_at']
        assert after['schedule']['enabled']
        assert restarted.get('/api/v1/discovery/jobs/' + str(queued)).json()['stage'] == 'Interrupted'
    assert not [r for r in requests if r.url.path == '/search.json']
    assert first['interval_seconds'] == resumed['interval_seconds'] == 172800


def test_one_search_can_supply_eleven_organic_manufacturers(database, monkeypatch):
    requests = mock_duckduckgo(monkeypatch, body={'organic_results': [
        {'link': f'https://manufacturer{i}.invalid/', 'title': 'Pakistani packaging manufacturer'} for i in range(11)]})
    _, results = asyncio.run(providers.duckduckgo_search({'product': 'corrugated'}))
    assert len(results) == 11
    _, again = asyncio.run(providers.duckduckgo_search({'product': 'corrugated'}))
    assert len(again) == 11 and all(r['cached'] for r in again)
    searches = [r for r in requests if r.url.path == '/search.json']
    assert len(searches) == 1 and searches[0].url.params['m'] == '50'
    assert 'start' not in searches[0].url.params


def test_all_provider_http_blocked_even_with_real_transport(database, monkeypatch):
    import httpx
    monkeypatch.setenv('SERPAPI_API_KEY', 'never-send-this')
    with pytest.raises(AssertionError, match='forbidden'):
        asyncio.run(providers.verify_account())
    with httpx.Client() as client:
        with pytest.raises(AssertionError, match='forbidden'):
            client.get('https://serpapi.com/account.json')
