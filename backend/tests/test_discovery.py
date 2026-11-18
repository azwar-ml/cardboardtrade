import asyncio
import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from agents.supplier_discovery import storage, safety, workflow
from agents.supplier_discovery.extraction import extract, validate
from main import app

HTML = '''<html><head><title>Fixture Packages</title><script type="application/ld+json">{"@type":"Organization","name":"Fixture Packages","address":{"addressLocality":"Lahore"}}</script></head><body>Fixture Packages manufactures corrugated carton boxes in Lahore Pakistan. <a href="mailto:business@fixture.invalid">Contact</a><a href="tel:+920000000">Phone</a></body></html>'''


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setenv('SERPAPI_API_KEY', '')
    monkeypatch.setattr('agents.supplier_discovery.providers.dotenv_values', lambda path: {})
    monkeypatch.setenv('TRADE_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('DISCOVERY_SCHEDULE_SECONDS', '0')
    monkeypatch.setenv('DISCOVERY_SEARCH_PROVIDER', 'seeds')
    monkeypatch.setenv('DISCOVERY_SEED_URLS', 'https://fixture.invalid/')
    schema = (Path(__file__).resolve().parents[2] / 'frontend/lib/trade/db.ts').read_text(encoding='utf-8').split('const SCHEMA = `')[1].split('`;')[0]
    conn = sqlite3.connect(tmp_path / 'trade.db')
    conn.executescript(schema)
    conn.execute("INSERT INTO users(id,name,email,initials,role,password_hash) VALUES(1,'Admin','admin@test.invalid','AD','admin','unused'),(2,'Sales','sales@test.invalid','SL','sales','unused')")
    conn.execute("INSERT INTO sessions VALUES('admin-token',1,'2099-01-01T00:00:00.000Z'),('sales-token',2,'2099-01-01T00:00:00.000Z')")
    conn.commit()
    conn.close()
    storage.migrate()
    return tmp_path


def test_migration_backup_idempotent_preserves_business(database):
    storage.migrate()
    assert len(list(database.glob('*.bak'))) == 1
    with storage.connection() as conn:
        assert conn.execute('SELECT count(*) FROM users').fetchone()[0] == 2
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'


def test_extraction_and_validation():
    data, evidence = extract(HTML, 'https://fixture.invalid/')
    assert data['company'] == 'Fixture Packages'
    assert data['email'] == 'business@fixture.invalid'
    assert data['phone'] == '+920000000'
    assert data['city'] == 'Lahore'
    assert evidence['snippets']
    assert not validate(data, {'city': 'Lahore', 'product': 'corrugated'})
    assert not validate(data, {'city': 'Lahore', 'product': 'corrugated boxes'})
    assert validate(data, {'product': 'corrugated plastic'})
    assert validate(data, {'city': 'Karachi'})
    assert validate(extract('<h1>No supplier evidence</h1>', 'https://fixture.invalid/')[0], {})


@pytest.mark.parametrize('url', ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'http://example.com:8080/', 'http://[::1]/'])
def test_ssrf_blocked(url):
    with pytest.raises((safety.UnsafeURL, OSError)):
        safety.resolve_public(url)


def test_mixed_dns_blocked():
    with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443)), (2, 1, 6, '', ('127.0.0.1', 443))]):
        with pytest.raises(safety.UnsafeURL):
            safety.resolve_public('https://example.com/')


def test_robots_restrictions_and_redirects():
    async def run():
        with patch.object(safety, 'resolve_public', return_value=(__import__('urllib.parse', fromlist=['urlsplit']).urlsplit('https://example.com/'), '8.8.8.8')):
            with patch.object(safety, 'fetch', return_value=(200, 'User-agent: *\nDisallow: /', '', 'text/plain')):
                with pytest.raises(safety.UnsafeURL):
                    await safety.permitted_page('https://example.com/', {'example.com'}, {})
            with pytest.raises(safety.UnsafeURL):
                await safety.permitted_page('https://example.com/', {'other.com'}, {})
    asyncio.run(run())


def test_cross_source_duplicate_and_vendor_preserved(database):
    data, evidence = extract(HTML, 'https://fixture.invalid/')
    with storage.connection() as conn:
        conn.execute("INSERT INTO vendors(code,name,email,notes) VALUES('FIX','Fixture Packages','business@fixture.invalid','Manually verified')")
        first, duplicate = storage.save_lead(conn, data, 'web:fixture', 'Automated Discovery', evidence, url=data['website'])
        assert duplicate
        second, duplicate = storage.save_lead(conn, data, 'form:fixture', 'Website Submission', {'reference': 'test'})
        assert duplicate and second == first
        storage.save_lead(conn, data, 'form:fixture', 'Website Submission', {})
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM discovery_sources').fetchone()[0] == 2
        assert conn.execute('SELECT notes FROM vendors').fetchone()[0] == 'Manually verified'
        assert conn.execute('SELECT status FROM discovery_leads').fetchone()[0] == 'Pending Review'


def test_seller_backfill_only_selling_and_all_references(database):
    with storage.connection() as conn:
        for id, subject in [('form1', 'Selling request'), ('form2', 'Selling request'), ('buy1', 'Buying request')]:
            conn.execute('''INSERT INTO enquiries(id,received_at,subject,first_name,last_name,email,company,country,product,message,attachments)
              VALUES(?,?,?,'Test','Only','fixture@fixture.invalid','Fixture Packages','Pakistan','Boxes','Original enquiry','["file.pdf"]')''', (id, storage.now(), subject))
    storage.sync_submissions()
    storage.sync_submissions()
    with storage.connection() as conn:
        assert conn.execute('SELECT count(*) FROM enquiries').fetchone()[0] == 3
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM discovery_sources').fetchone()[0] == 2
        assert 'file.pdf' in conn.execute('SELECT evidence FROM discovery_sources').fetchone()[0]


def test_admin_auth_and_review(database):
    client = TestClient(app)
    assert client.get('/api/v1/discovery/leads').status_code == 401
    assert client.get('/api/v1/discovery/leads', cookies={'cp_session': 'sales-token'}).status_code == 403
    client.cookies.set('cp_session', 'admin-token')
    assert client.get('/api/v1/discovery/leads?page=0').status_code == 422
    with storage.connection() as conn:
        id, _ = storage.save_lead(conn, extract(HTML, 'https://fixture.invalid/')[0], 'test', 'Automated Discovery', {})
    assert client.get(f'/api/v1/discovery/leads/{id}').json()['sources']
    assert client.post(f'/api/v1/discovery/leads/{id}/review', json={'action': 'review'}, headers={'origin': 'https://attacker.invalid'}).status_code == 403
    assert client.post(f'/api/v1/discovery/leads/{id}/review', json={'action': 'review'}).json()['status'] == 'Reviewed'
    assert client.post(f'/api/v1/discovery/leads/{id}/review', json={'action': 'duplicate', 'linked_lead_id': id}).status_code == 422
    assert client.post(f'/api/v1/discovery/leads/{id}/review', json={'action': 'dismiss'}).json()['status'] == 'Dismissed'
    assert client.get('/api/v1/discovery/summary').json()['pending_review'] == 0


def test_real_graph_crawlee_lifecycle_failures_and_repeat(database):
    async def page(url, allowed, robots):
        if 'failed' in url:
            raise ValueError('HTTP 500')
        if 'blocked' in url:
            raise safety.UnsafeURL('Disallowed by robots.txt')
        return HTML, url
    async def run():
        with patch.object(workflow, 'permitted_page', side_effect=page):
            id = workflow.create_job({'seed_urls': ['https://fixture.invalid/', 'https://failed.invalid/', 'https://blocked.invalid/']}, 'test')
            await workflow.run_job(id)
            repeat = workflow.create_job({'mode': 'seeds'}, 'test')
            await workflow.run_job(repeat)
        with storage.connection() as conn:
            assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 1
            row = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (id,)).fetchone()
            assert row['found'] == 1 and row['failed'] == 1 and row['skipped'] == 1, dict(row)
            assert conn.execute('SELECT duplicates FROM discovery_jobs WHERE id=?', (repeat,)).fetchone()[0] == 1
    asyncio.run(run())


def test_no_config_and_empty_search(database, monkeypatch):
    monkeypatch.setenv('DISCOVERY_SEED_URLS', '')
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    assert client.post('/api/v1/discovery/jobs', json={}).status_code == 422
    id = workflow.create_job({'mode': 'seeds'}, 'test')
    asyncio.run(workflow.run_job(id))
    with storage.connection() as conn:
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 0
        assert conn.execute('SELECT skipped FROM discovery_jobs WHERE id=?', (id,)).fetchone()[0] == 1


def test_manual_trigger_and_overlap(database):
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    async def page(url, allowed, robots):
        return HTML, url
    with patch.object(workflow, 'permitted_page', side_effect=page):
        response = client.post('/api/v1/discovery/jobs', json={'mode': 'seeds', 'city': 'Lahore'})
    assert response.status_code == 202
    assert client.get('/api/v1/discovery/jobs/' + str(response.json()['id'])).json()['found'] == 1
    workflow.create_job({}, 'test')
    assert client.post('/api/v1/discovery/jobs', json={'mode': 'seeds'}).status_code == 409


def test_scheduler_configuration_and_execution(database, monkeypatch):
    monkeypatch.setenv('DISCOVERY_SCHEDULE_SECONDS', '3600')
    assert workflow.configuration()['schedule_seconds'] == 3600
    from agents.supplier_discovery.scheduling import schedule_status
    schedule_status()
    with storage.connection() as conn:
        conn.execute('UPDATE discovery_schedule SET next_run_at=?', (storage.now(),))
    async def fake_run(id):
        with storage.connection() as conn:
            conn.execute("UPDATE discovery_jobs SET status='Completed' WHERE id=?", (id,))
        raise asyncio.CancelledError()
    with patch.object(workflow, 'run_job', side_effect=fake_run):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(workflow.scheduler())
    with storage.connection() as conn:
        assert conn.execute('SELECT trigger_type FROM discovery_jobs').fetchone()[0] == 'Scheduled'


def test_duplicate_vendor_link_and_review_is_not_approval(database):
    with storage.connection() as conn:
        vendor = conn.execute("INSERT INTO vendors(code,name,status) VALUES('TARGET','Existing verified company','active')").lastrowid
        lead, _ = storage.save_lead(conn, extract(HTML, 'https://fixture.invalid/')[0], 'duplicate-test', 'Automated Discovery', {})
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    response = client.post(f'/api/v1/discovery/leads/{lead}/review', json={'action': 'duplicate', 'linked_vendor_id': vendor, 'note': 'Operator matched company'})
    assert response.status_code == 200
    with storage.connection() as conn:
        row = conn.execute('SELECT * FROM discovery_leads WHERE id=?', (lead,)).fetchone()
        assert row['status'] == 'Duplicate' and row['linked_vendor_id'] == vendor
        assert conn.execute('SELECT status FROM vendors WHERE id=?', (vendor,)).fetchone()[0] == 'active'
        assert conn.execute('SELECT count(*) FROM items').fetchone()[0] == 0


def test_search_failure_is_recorded_without_fake_leads(database):
    async def fail(state):
        raise ValueError('Search service unavailable')
    id = workflow.create_job({}, 'test')
    with patch.object(workflow, 'search', side_effect=fail):
        asyncio.run(workflow.run_job(id))
    with storage.connection() as conn:
        row = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (id,)).fetchone()
        assert row['status'] == 'Failed' and 'Search service unavailable' in row['error']
        assert conn.execute('SELECT status FROM discovery_attempts').fetchone()[0] == 'Failed'
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 0


def test_redirect_destination_is_checked_before_access():
    from urllib.parse import urlsplit
    resolved = []
    def resolve(url):
        resolved.append(url)
        if '127.0.0.1' in url:
            raise safety.UnsafeURL('Private redirect blocked')
        return urlsplit(url), '8.8.8.8'
    def fetched(url, redirects=3):
        if url.endswith('robots.txt'):
            return 200, 'User-agent: *\nAllow: /', url, 'text/plain'
        return 302, '', 'http://127.0.0.1/private', ''
    with patch.object(safety, 'resolve_public', side_effect=resolve), patch.object(safety, 'fetch', side_effect=fetched), patch.object(safety.asyncio, 'sleep', return_value=None):
        with pytest.raises(safety.UnsafeURL):
            asyncio.run(safety.permitted_page('https://example.com/', {'example.com'}, {}))
    assert resolved[-1] == 'http://127.0.0.1/private'


def test_admin_public_seed_permission_and_network_validation(database, monkeypatch):
    monkeypatch.setenv('DISCOVERY_SEED_URLS', '')
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    payload = {'seed_urls': ['https://example.com/']}
    assert client.post('/api/v1/discovery/jobs', json=payload).status_code == 422
    payload['source_permission_confirmed'] = True
    async def page(url, allowed, robots):
        assert 'example.com' in allowed
        return HTML, url
    with patch('agents.supplier_discovery.api.resolve_public'), patch.object(workflow, 'permitted_page', side_effect=page):
        response = client.post('/api/v1/discovery/jobs', json=payload)
    assert response.status_code == 202
    summary = client.get('/api/v1/discovery/summary').json()
    assert summary['latest_job']['id'] == response.json()['id']
    assert summary['latest_job']['status'] == 'Completed'
    assert summary['latest_job']['found'] == 1
    payload['seed_urls'] = ['http://127.0.0.1/']
    assert client.post('/api/v1/discovery/jobs', json=payload).status_code == 422


def test_health_identifies_discovery_capability():
    result = TestClient(app).get('/health').json()
    assert result['status'] == 'ok'
    assert 'supplier-discovery' in result['capabilities']


def mock_duckduckgo(monkeypatch, status=200, body=None):
    import httpx
    from agents.supplier_discovery import providers
    monkeypatch.setenv('DISCOVERY_SEARCH_PROVIDER', 'duckduckgo')
    monkeypatch.setenv('DISCOVERY_SOURCE_POLICY', 'public')
    monkeypatch.setenv('SERPAPI_API_KEY', 'isolated-fake-search-token')
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path == '/account.json':
            return httpx.Response(200, json={'this_month_usage': 0, 'plan_searches_left': 250, 'total_searches_left': 250, 'searches_per_month': 250, 'account_status': 'Active', 'plan_renewal_date': '2026-12-17'})
        return httpx.Response(status, json=body if body is not None else {'organic_results': [{'link': 'https://fixture.invalid/', 'title': 'Fixture Packages', 'snippet': 'Pakistani packaging manufacturer'}]})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(providers.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    return requests


def test_automatic_search_graph_query_provenance_persistence_and_repeat(database, monkeypatch):
    requests = mock_duckduckgo(monkeypatch)
    async def page(url, allowed, robots):
        assert allowed is None  # Explicit public-source policy; production transport still validates DNS/robots.
        return HTML, url
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    with patch.object(workflow, 'permitted_page', side_effect=page):
        first = client.post('/api/v1/discovery/jobs', json={'mode': 'automatic', 'product': 'corrugated', 'city': 'Lahore', 'keywords': 'manufactures'})
        second = client.post('/api/v1/discovery/jobs', json={'mode': 'automatic', 'product': 'corrugated', 'city': 'Lahore'})
    assert first.status_code == second.status_code == 202
    assert requests[1].url.params['api_key'] == 'isolated-fake-search-token'
    assert requests[1].url.params['q'] == 'Pakistan packaging manufacturer corrugated Lahore manufactures'
    result = client.get('/api/v1/discovery/jobs/' + str(first.json()['id'])).json()
    assert result['status'] == 'Completed' and result['found'] == 1
    assert result['search_results'][0]['provider'] == 'duckduckgo'
    assert result['search_results'][0]['disposition'] == 'Crawled'
    summary = client.get('/api/v1/discovery/summary').json()
    assert summary['provider_check']['status'] == 'Ready'
    assert summary['total'] == 1 and summary['duplicates'] == 0
    assert 'cooldown' in client.get('/api/v1/discovery/jobs/' + str(second.json()['id'])).json()['search_results'][0]['disposition']
    assert 'isolated-fake-search-token' not in json.dumps(summary)
    assert 'fingerprint' not in json.dumps(summary)
    detail = client.get('/api/v1/discovery/leads/1').json()
    assert detail['sources'][0]['evidence']['search_reference']['provider'] == 'duckduckgo'


@pytest.mark.parametrize('status,expected', [(401, 'credentials'), (403, 'subscription'), (429, 'quota'), (500, 'HTTP 500')])
def test_search_provider_errors_are_safe_and_recorded(database, monkeypatch, status, expected):
    mock_duckduckgo(monkeypatch, status, {'error': {'detail': 'isolated-fake-search-token must not leak'}})
    id = workflow.create_job({'mode': 'automatic', 'product': 'packaging'}, 'test')
    asyncio.run(workflow.run_job(id))
    with storage.connection() as conn:
        row = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (id,)).fetchone()
        assert row['status'] == ('Paused' if status == 429 else 'Failed') and expected.lower() in row['error'].lower()
        assert 'isolated-fake-search-token' not in row['error']
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 0
        if status != 429:
            assert conn.execute('SELECT status FROM discovery_attempts').fetchone()[0] == 'Failed'


def test_search_empty_results_are_genuine_zero_and_allowlist_is_enforced(database, monkeypatch):
    mock_duckduckgo(monkeypatch, body={'organic_results': []})
    id = workflow.create_job({'mode': 'automatic', 'product': 'packaging'}, 'test')
    asyncio.run(workflow.run_job(id))
    with storage.connection() as conn:
        assert conn.execute('SELECT found FROM discovery_jobs WHERE id=?', (id,)).fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 0


def test_new_backend_file_key_is_detected_without_restart(monkeypatch):
    from agents.supplier_discovery import providers
    monkeypatch.delenv('SERPAPI_API_KEY', raising=False)
    monkeypatch.setenv('DISCOVERY_SEARCH_PROVIDER', 'duckduckgo')
    monkeypatch.setenv('DISCOVERY_SOURCE_POLICY', 'public')
    local = {}
    monkeypatch.setattr(providers, 'dotenv_values', lambda path: local)
    assert not providers.configuration()['automatic_ready']
    local['SERPAPI_API_KEY'] = 'new-local-fake-key'
    assert providers.configuration()['automatic_ready']
    assert 'new-local-fake-key' not in json.dumps(providers.configuration())


def test_allowlist_blocks_new_search_domains_without_crawling(database, monkeypatch):
    mock_duckduckgo(monkeypatch, body={'organic_results': [{'link': 'https://unapproved.invalid/', 'title': 'Unapproved packaging manufacturer'}]})
    monkeypatch.setenv('DISCOVERY_SOURCE_POLICY', 'allowlist')
    id = workflow.create_job({'mode': 'automatic', 'product': 'packaging'}, 'test')
    with patch.object(workflow, 'permitted_page') as page:
        asyncio.run(workflow.run_job(id))
        page.assert_not_called()
    with storage.connection() as conn:
        assert 'not permitted' in conn.execute('SELECT disposition FROM discovery_search_results').fetchone()[0]
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 0


def test_persistent_schedule_filters_due_time_overlap_and_disable(database, monkeypatch):
    from agents.supplier_discovery.scheduling import schedule_status
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    saved = client.post('/api/v1/discovery/schedule', json={'enabled': True, 'interval_seconds': 60,
        'filters': {'product': 'corrugated', 'city': 'Lahore', 'keywords': 'manufactures'}})
    assert saved.status_code == 200 and saved.json()['status'] == 'Scheduled'
    assert saved.json()['next_run_at'] > storage.now()
    with storage.connection() as conn:
        conn.execute('UPDATE discovery_schedule SET next_run_at=?', (storage.now(),))
    active = workflow.create_job({}, 'test')
    assert asyncio.run(workflow.scheduler_tick()) is None
    assert schedule_status()['status'] == 'Waiting for active job'
    with storage.connection() as conn:
        conn.execute("UPDATE discovery_jobs SET status='Completed' WHERE id=?", (active,))
    async def page(url, allowed, robots):
        return HTML, url
    with patch.object(workflow, 'permitted_page', side_effect=page):
        scheduled = asyncio.run(workflow.scheduler_tick())
        assert scheduled
        assert asyncio.run(workflow.scheduler_tick()) is None
    with storage.connection() as conn:
        row = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (scheduled,)).fetchone()
        assert row['trigger_type'] == 'Scheduled'
        assert json.loads(row['filters'])['city'] == 'Lahore'
        assert json.loads(row['filters'])['keywords'] == 'manufactures'
    response = client.post('/api/v1/discovery/schedule', json={'enabled': False, 'interval_seconds': 60,
        'filters': {'product': 'corrugated', 'city': 'Lahore', 'keywords': 'manufactures'}})
    assert response.json()['status'] == 'Disabled'
    monkeypatch.setenv('DISCOVERY_SCHEDULE_SECONDS', '120')
    assert schedule_status()['status'] == 'Disabled', 'Persisted Admin disable survives environment defaults/restart'


def test_missing_search_key_does_not_disable_manual_research(database, monkeypatch):
    from agents.supplier_discovery import providers
    monkeypatch.setenv('DISCOVERY_SEARCH_PROVIDER', 'duckduckgo')
    monkeypatch.delenv('SERPAPI_API_KEY', raising=False)
    monkeypatch.setattr(providers, 'dotenv_values', lambda path: {})
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    assert client.post('/api/v1/discovery/jobs', json={'mode': 'automatic', 'product': 'boxes'}).status_code == 422
    async def page(url, allowed, robots):
        return HTML, url
    with patch('agents.supplier_discovery.api.resolve_public'), patch.object(workflow, 'permitted_page', side_effect=page):
        result = client.post('/api/v1/discovery/jobs', json={'mode': 'manual', 'seed_urls': ['https://fixture.invalid/'], 'source_permission_confirmed': True})
    assert result.status_code == 202
    summary = client.get('/api/v1/discovery/summary').json()
    assert summary['total'] == 1 and not summary['configuration']['automatic_ready']


def test_database_path_is_absolute_and_independent_of_cwd(monkeypatch, tmp_path):
    monkeypatch.setenv('TRADE_DATA_DIR', 'data')
    expected = Path(__file__).resolve().parents[2] / 'frontend/data/trade.db'
    monkeypatch.chdir(tmp_path)
    assert storage.database_path() == expected.resolve()
    assert storage.database_path().is_absolute()


def test_seed_schedule_independent_of_missing_duckduckgo(database, monkeypatch):
    from agents.supplier_discovery.scheduling import save_schedule, schedule_status
    monkeypatch.setenv('DISCOVERY_SEARCH_PROVIDER', 'duckduckgo')
    monkeypatch.setattr('agents.supplier_discovery.providers.credential', lambda: '')
    saved = save_schedule({'enabled': True, 'interval_seconds': 60,
                           'filters': {'product': '', 'city': '', 'keywords': '', 'mode': 'seeds'}}, 'test')
    assert saved['status'] == 'Scheduled'
    with storage.connection() as conn:
        conn.execute("UPDATE discovery_schedule SET next_run_at='2000-01-01T00:00:00.000Z'")
    with patch.object(workflow, 'permitted_page', return_value=(HTML, 'https://fixture.invalid/')):
        job_id = asyncio.run(workflow.scheduler_tick())
    with storage.connection() as conn:
        job = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()
        assert job['status'] == 'Completed'
        assert json.loads(job['filters'])['mode'] == 'seeds'
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 1
    save_schedule({'enabled': True, 'interval_seconds': 60, 'filters': {'mode': 'automatic'}}, 'test')
    assert schedule_status()['status'] == 'Blocked'


def test_last_success_excludes_failed_and_empty_runs(database):
    with storage.connection() as conn:
        for status, found, date in [('Completed', 1, '2026-01-01T00:00:00.000Z'), ('Completed', 0, '2026-01-02T00:00:00.000Z'), ('Failed', 0, '2026-01-03T00:00:00.000Z')]:
            conn.execute("INSERT INTO discovery_jobs(trigger_type,actor,status,stage,filters,created_at,finished_at,found) VALUES('Manual','test',?,'Finished','{}',?,?,?)", (status, date, date, found))
    with TestClient(app) as client:
        client.cookies.set('cp_session', 'admin-token')
        response = client.get('/api/v1/discovery/summary')
        assert response.json()['last_research'] == '2026-01-01T00:00:00.000Z'
        assert response.headers['x-trade-database'] == storage.database_fingerprint()


def test_duckduckgo_organic_only_cache_and_budget(database, monkeypatch):
    from agents.supplier_discovery import providers
    requests = mock_duckduckgo(monkeypatch, body={'ads': [{'link': 'https://ad.invalid/'}], 'organic_results': [
        {'link': 'https://fixture.invalid/', 'title': 'Packaging manufacturer', 'snippet': 'Corrugated boxes Pakistan'},
        {'link': 'https://sponsored.invalid/', 'is_ad': True}]})
    first = asyncio.run(providers.duckduckgo_search({'product': 'boxes'}))
    second = asyncio.run(providers.duckduckgo_search({'product': 'boxes'}))
    assert first[0] == second[0] and len(first[1]) == 1
    assert second[1][0]['cached'] is True
    searches = [r for r in requests if r.url.path == '/search.json']
    assert len(searches) == 1
    assert searches[0].url.params['engine'] == 'duckduckgo'
    assert 'start' not in searches[0].url.params and 'no_cache' not in searches[0].url.params
    assert providers.usage_status()['used'] == 1
    monkeypatch.setenv('DISCOVERY_MONTHLY_SEARCH_LIMIT', '1')
    with pytest.raises(providers.SearchError, match='budget'):
        asyncio.run(providers.duckduckgo_search({'product': 'carton'}))
    assert len([r for r in requests if r.url.path == '/search.json']) == 1


def test_exhausted_account_never_searches(database, monkeypatch):
    import httpx
    from agents.supplier_discovery import providers
    monkeypatch.setenv('SERPAPI_API_KEY', 'fake-only')
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={'this_month_usage': 200, 'plan_searches_left': 50, 'total_searches_left': 50, 'searches_per_month': 250, 'account_status': 'Active', 'plan_renewal_date': '2026-12-17'})
    real = httpx.AsyncClient
    monkeypatch.setattr(providers.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    with pytest.raises(providers.SearchError, match='reserved'):
        asyncio.run(providers.duckduckgo_search({'product': 'boxes'}))
    assert len(requests) == 1 and requests[0].url.path == '/account.json'


def test_failed_search_is_not_charged_twice(database, monkeypatch):
    from agents.supplier_discovery import providers
    requests = mock_duckduckgo(monkeypatch, status=429)
    with pytest.raises(providers.SearchError):
        asyncio.run(providers.duckduckgo_search({'product': 'boxes'}))
    with pytest.raises(providers.SearchError, match='already attempted'):
        asyncio.run(providers.duckduckgo_search({'product': 'boxes'}))
    assert len([r for r in requests if r.url.path == '/search.json']) == 1
    assert providers.usage_status()['used'] == 1


def test_provider_error_payload_and_logs_cannot_expose_key(database, monkeypatch):
    import logging
    from agents.supplier_discovery import providers
    mock_duckduckgo(monkeypatch, body={'error': 'isolated-fake-search-token'})
    with pytest.raises(providers.SearchError) as exc:
        asyncio.run(providers.duckduckgo_search({'product': 'boxes'}))
    assert 'isolated-fake-search-token' not in str(exc.value)
    record = logging.LogRecord('httpx', logging.INFO, '', 0, 'HTTP GET https://serpapi.com/search.json?api_key=SECRET&q=boxes', (), None)
    providers.RedactCredentials().filter(record)
    assert 'SECRET' not in record.getMessage()


def test_cancel_queued_job_and_pause_are_admin_only_and_persistent(database):
    client = TestClient(app)
    id = workflow.create_job({'mode': 'seeds'}, 'test')
    assert client.post(f'/api/v1/discovery/jobs/{id}/cancel').status_code == 401
    client.cookies.set('cp_session', 'sales-token')
    assert client.post(f'/api/v1/discovery/jobs/{id}/cancel').status_code == 403
    assert client.post('/api/v1/discovery/schedule/pause').status_code == 403
    client.cookies.set('cp_session', 'admin-token')
    assert client.post(f'/api/v1/discovery/jobs/{id}/cancel').json()['status'] == 'Cancelled'
    asyncio.run(workflow.run_job(id))
    assert client.post(f'/api/v1/discovery/jobs/{id}/cancel').json()['status'] == 'Cancelled'
    assert client.post('/api/v1/discovery/schedule/pause').json()['enabled'] is False
    assert client.get('/api/v1/discovery/summary').json()['schedule']['next_run_at'] is None
    assert client.get('/api/v1/discovery/jobs/' + str(id)).json()['status'] == 'Cancelled'


def test_cancel_running_job_stops_graph_before_persist(database):
    async def run():
        entered = asyncio.Event()
        async def slow_page(url, allowed, robots):
            entered.set()
            await asyncio.sleep(30)
            return HTML, url
        id = workflow.create_job({'mode': 'seeds'}, 'test')
        with patch.object(workflow, 'permitted_page', side_effect=slow_page):
            worker = asyncio.create_task(workflow.run_job(id))
            await asyncio.wait_for(entered.wait(), timeout=5)
            assert await workflow.cancel_job(id, 'Admin') == 'Cancelled'
            await asyncio.wait_for(worker, timeout=5)
        with storage.connection() as conn:
            assert conn.execute('SELECT status FROM discovery_jobs WHERE id=?', (id,)).fetchone()[0] == 'Cancelled'
            assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 0
            assert conn.execute('SELECT count(*) FROM discovery_activity WHERE action=\'Cancelled by Admin\'').fetchone()[0] == 1
        assert id not in workflow.running_jobs
    asyncio.run(run())


def test_provider_account_check_is_free(database, monkeypatch):
    requests = mock_duckduckgo(monkeypatch)
    client = TestClient(app)
    client.cookies.set('cp_session', 'admin-token')
    result = client.post('/api/v1/discovery/provider/check', json={})
    assert result.status_code == 200 and result.json()['searches_used'] == 0
    assert all(r.url.path == '/account.json' for r in requests)


def test_search_duplicate_domains_and_irrelevant_results_not_crawled(database, monkeypatch):
    mock_duckduckgo(monkeypatch, body={'organic_results': [
        {'link': 'https://fixture.invalid/', 'title': 'Packaging manufacturer'},
        {'link': 'https://fixture.invalid/contact', 'title': 'Packaging contact'},
        {'link': 'https://facebook.com/company', 'title': 'Packaging'},
        {'link': 'https://unrelated.invalid/', 'title': 'Weather'}]})
    id = workflow.create_job({'mode': 'automatic', 'product': 'corrugated'}, 'test')
    with patch.object(workflow, 'permitted_page', return_value=(HTML, 'https://fixture.invalid/')) as page:
        asyncio.run(workflow.run_job(id))
        assert page.call_count == 1
    with storage.connection() as conn:
        assert conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0] == 1
        assert conn.execute('SELECT skipped FROM discovery_jobs WHERE id=?', (id,)).fetchone()[0] == 3
