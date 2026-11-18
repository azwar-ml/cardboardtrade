import asyncio
import json
import hashlib
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest
from test_qualification import qualification, fake_client, STAMP
from test_discovery import database
from agents.supplier_discovery import storage as discovery
from agents.supplier_qualification import gemini, workflow
from agents.supplier_qualification.models import Evidence, Extraction


@pytest.fixture
def configured(qualification, monkeypatch):
    config = {f'GEMINI_API_KEY_{i}': f'fixture-secret-{i}' for i in range(1, 4)}
    config['GEMINI_API_KEY_4'] = 'unused-fixture-secret'
    config['QUALIFICATION_ADDITIONAL_AI_ENABLED'] = 'true'
    monkeypatch.setattr(gemini, 'settings', lambda: config)
    return config


def source():
    return Evidence(id='one', url='https://fixture.invalid/', observed_at=STAMP, kind='supplier',
                    text='Fixture Packages manufactures cartons. PKR 100 per 10 pieces.')


def response():
    return SimpleNamespace(text='{"facts":[]}',
                           usage_metadata=SimpleNamespace(prompt_token_count=30, candidates_token_count=10, thoughts_token_count=0))


def test_fixed_assignments_no_other_keys(configured):
    assert [gemini.credential(workload) for workload in gemini.WORKLOADS] == ['fixture-secret-1', 'fixture-secret-2', 'fixture-secret-3']
    assert [row['key_name'] for row in gemini.configuration()['workloads']] == ['GEMINI_API_KEY_1', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3']
    with pytest.raises(ValueError):
        gemini.credential('fallback')
    assert 'fixture-secret' not in json.dumps(gemini.configuration())
    assert 'fixture-secret' not in gemini.safe_error(RuntimeError('fixture-secret-1 fixture-secret-2 fixture-secret-3'))


def test_disabled_third_key_never_opens_a_client(configured):
    configured['QUALIFICATION_ADDITIONAL_AI_ENABLED'] = 'false'
    with patch.object(gemini, 'client', side_effect=AssertionError('Disabled key must never open a client')):
        assert gemini.credential('additional') == ''
        assert gemini.analyze(888, [source()], 'additional', 'Conflicting evidence')['status'] == 'Skipped'


def test_wire_schema_limits_provider_constraint_complexity(configured):
    supplier = gemini.extraction_schema('supplier')
    market = gemini.extraction_schema('market')
    assert set(supplier['properties']) == {'facts'}
    assert set(market['properties']) == {'items'}
    serialized = json.dumps(market)
    for constraint in ('maxItems', 'maxLength', 'exclusiveMinimum', 'pattern', 'format', 'enum', '$ref', '$defs', 'anyOf'):
        assert constraint not in serialized
    assert all(field == {'type': 'string'} for field in market['properties']['items']['items']['properties'].values())
    assert len(json.dumps(supplier)) < len(json.dumps(Extraction.model_json_schema())) / 3


def test_configured_model_requires_api_compatibility_and_free_tier_metadata(configured):
    api = MagicMock()
    api.models.list.return_value = [SimpleNamespace(name='models/gemini-3.5-flash-lite', supported_actions=['embedContent']),
                                    SimpleNamespace(name='models/gemini-3.1-flash-lite', supported_actions=['generateContent']),
                                    SimpleNamespace(name='models/gemini-4-pro', supported_actions=['generateContent'])]
    assert gemini.select_model(api) == 'models/gemini-3.1-flash-lite'
    configured['GEMINI_MODEL'] = 'gemini-3.5-flash-lite'
    with pytest.raises(ValueError, match='absent'):
        gemini.select_model(api)
    configured['GEMINI_MODEL'] = 'gemini-4-pro'
    with pytest.raises(ValueError):
        gemini.select_model(api)


def test_all_workloads_have_separate_caches_and_strict_aggregate_budget(configured):
    context, api = fake_client(response())
    def generated(*args, **kwargs):
        root = next(iter(kwargs['config'].response_json_schema['properties']))
        result = response()
        result.text = json.dumps({root: []})
        return result
    api.models.generate_content.side_effect = generated
    with patch.object(gemini, 'client', return_value=context) as clients:
        for workload in gemini.WORKLOADS:
            result = gemini.analyze(700, [source()], workload, 'Conflicting source identity' if workload == 'additional' else '')
            assert result['status'] == 'Available', result
            assert result['key_name'] == gemini.key_name(workload)
        assert gemini.analyze(701, [source()], 'market')['cached']
        assert api.models.generate_content.call_count == 3
        assert api.models.list.call_count == 3
        assert [call.args[0] for call in clients.call_args_list] == ['supplier', 'market', 'additional', 'market']
    with discovery.connection() as conn:
        totals = conn.execute("SELECT count(*),SUM(reserved_output_tokens),SUM(request_sent) FROM qualification_ai_usage WHERE purpose='analysis'").fetchone()
        assert tuple(totals) == (3, 2400, 3)
    with pytest.raises(ValueError, match='budget'):
        gemini.reserve_request(700, 'supplier', 'models/gemini-3.5-flash-lite', 100, 1)


@pytest.mark.parametrize('error', ['429 RESOURCE_EXHAUSTED shared quota', 'Quota exceeded for project'])
def test_project_quota_failures_pause_all_workloads(configured, error):
    context, api = fake_client(error=RuntimeError(error))
    with patch.object(gemini, 'client', return_value=context) as clients:
        assert gemini.analyze(800, [source()])['status'] == 'Unavailable'
        for workload in ('market', 'additional'):
            result = gemini.analyze(801, [source()], workload, 'Conflicting sources')
            assert result['status'] == 'Unavailable'
            assert error in result['reason']
    assert clients.call_count == 1
    assert api.models.generate_content.call_count == 1


def test_billing_denial_stays_with_assigned_workload_and_never_reroutes(configured):
    context, api = fake_client(error=RuntimeError('403 PERMISSION_DENIED free tier unavailable; set up billing'))
    with patch.object(gemini, 'client', return_value=context) as clients:
        result = gemini.analyze(803, [source()], 'additional', 'Conflicting sources')
        assert result['status'] == 'Unavailable'
        assert '403 PERMISSION_DENIED' in result['reason']
        assert gemini.analyze(804, [source()], 'additional', 'Conflicting sources')['status'] == 'Unavailable'
    assert api.models.generate_content.call_count == 1
    assert all(call.args == ('additional',) for call in clients.call_args_list)
    with discovery.connection() as conn:
        assert gemini.quota_reason(conn) is None


def test_invalid_quota_acknowledgement_does_not_clear_shared_pause(configured):
    gemini.provider_failure(RuntimeError('429 RESOURCE_EXHAUSTED fixture'), 'supplier', 'fixture-identity')
    configured['GEMINI_QUOTA_REVIEWED_AT'] = 'invalid-future-timestamp'
    with discovery.connection() as conn:
        assert 'RESOURCE_EXHAUSTED' in gemini.quota_reason(conn)


@pytest.mark.parametrize('error', [RuntimeError('404 NOT_FOUND retired model'), httpx.ConnectError('Network unavailable')])
def test_provider_errors_preserved_no_automatic_retries(configured, error):
    context, api = fake_client(error=error)
    with patch.object(gemini, 'client', return_value=context):
        result = gemini.analyze(900, [source()])
        assert result['status'] == 'Unavailable'
        assert str(error) in result['reason']
        assert gemini.analyze(901, [source()])['status'] == 'Unavailable'
    assert api.models.generate_content.call_count == 1


def test_legacy_404_does_not_block_current_model_or_modify_history(configured):
    with discovery.connection() as conn:
        conn.execute("INSERT INTO qualification_ai_usage(purpose,model,status,error,created_at) VALUES('live-probe','models/gemini-2.5-flash-lite','Unavailable','404 NOT_FOUND',?)", (discovery.now(),))
    context, api = fake_client(response())
    with patch.object(gemini, 'client', return_value=context):
        assert gemini.analyze(1000, [source()])['status'] == 'Available'
    with discovery.connection() as conn:
        assert conn.execute("SELECT error FROM qualification_ai_usage WHERE purpose='live-probe'").fetchone()[0] == '404 NOT_FOUND'


def test_additional_key_requires_specific_need(configured):
    with patch.object(gemini, 'client', side_effect=AssertionError('Additional key must remain idle')):
        assert gemini.analyze(2, [source()], 'additional')['status'] == 'Skipped'


def test_existing_completed_fallback_can_be_reevaluated_through_normal_entry_point(configured):
    with discovery.connection() as conn:
        lead_id = conn.execute('SELECT id FROM discovery_leads LIMIT 1').fetchone()[0]
    payload = {'ai': True, 'research': False}
    snapshot = workflow.lead_snapshot(lead_id)
    old_digest = hashlib.sha256(json.dumps([snapshot, payload, 'rules-v1'], sort_keys=True).encode()).hexdigest()
    with discovery.connection() as conn:
        previous = conn.execute("""INSERT INTO qualification_jobs(lead_id,kind,status,actor,input,fingerprint,created_at)
            VALUES(?,'verification','Completed','old-version',?,?,?)""", (lead_id,json.dumps(payload),old_digest,discovery.now())).lastrowid
    current, reused = workflow.create_job('verification', payload, 'admin', lead_id)
    assert not reused and current != previous
    assert workflow.create_job('verification', payload, 'admin', lead_id) == (current, True)


def test_probe_primary_gate_three_total_and_repeated_commands_reuse_results(configured):
    context, api = fake_client()
    with patch.object(gemini, 'client', return_value=context):
        assert gemini.probe('market')['generation_requests'] == 0
        for workload in gemini.WORKLOADS:
            assert gemini.probe(workload)['status'] == 'Passed'
            assert gemini.probe(workload)['previous_probe_reused']
    assert api.models.generate_content.call_count == 3


def test_real_sdk_wire_format_minimal_thinking_no_retries(configured):
    from google import genai
    from google.genai import types
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(429, json={'error': {'code': 429, 'message': 'RESOURCE_EXHAUSTED fixture quota', 'status': 'RESOURCE_EXHAUSTED'}})

    with genai.Client(api_key='fixture-only', http_options=types.HttpOptions(
        api_version='v1beta', retry_options=types.HttpRetryOptions(attempts=1),
        client_args={'transport': httpx.MockTransport(handler)})) as api:
        with pytest.raises(Exception, match='RESOURCE_EXHAUSTED'):
            api.models.generate_content(model='models/gemini-3.5-flash-lite', contents='Return JSON',
                config=gemini.generation_config('models/gemini-3.5-flash-lite', 96, gemini.ProbeResponse.model_json_schema()))
    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body['generationConfig']['thinkingConfig']['thinkingLevel'] == 'MINIMAL'
    assert body['generationConfig']['responseMimeType'] == 'application/json'
    assert body['generationConfig']['maxOutputTokens'] == 96
    assert '/v1beta/models/gemini-3.5-flash-lite:generateContent' in str(requests[0].url)


def test_workflow_routes_supplier_market_and_conditional_additional(configured):
    with discovery.connection() as conn:
        lead_id = conn.execute('SELECT id FROM discovery_leads LIMIT 1').fetchone()[0]
    lead, _ = workflow.lead_snapshot(lead_id)
    calls = []

    def analysis(job_id, evidence, workload, reason=''):
        calls.append(workload)
        return {'status': 'Available', 'key_name': gemini.key_name(workload), 'analysis': Extraction().model_dump(mode='json')}

    state = {'job': {'id': 12, 'input': {'ai': True}}, 'lead': lead, 'evidence': [source()], 'errors': []}
    with patch.object(gemini, 'analyze', side_effect=analysis):
        result = asyncio.run(workflow.evaluate(state))
        assert calls == ['supplier', 'market']
        assert result['report']['admin_approval_required']
        calls.clear()
        with patch.object(workflow, 'verify', return_value={'findings': [{'result': 'Conflicting'}], 'risk_flags': []}):
            asyncio.run(workflow.evaluate(state))
        assert calls == ['supplier', 'market', 'additional']
        calls.clear()
        asyncio.run(workflow.evaluate({**state, 'lead': {}}))
        assert calls == ['market']


def test_supplier_job_allowlist_reserves_market_request_for_separate_job(configured):
    with discovery.connection() as conn:
        lead_id = conn.execute('SELECT id FROM discovery_leads LIMIT 1').fetchone()[0]
    lead, _ = workflow.lead_snapshot(lead_id)
    result = {'status': 'Available', 'analysis': Extraction().model_dump(mode='json')}
    with patch.object(gemini, 'analyze', return_value=result) as analyze:
        asyncio.run(workflow.evaluate({'job': {'id': 111, 'input': {'ai': True, 'ai_workloads': ['supplier']}},
                                      'lead': lead, 'evidence': [source()], 'errors': []}))
    assert analyze.call_count == 1
    assert analyze.call_args.args[2] == 'supplier'
