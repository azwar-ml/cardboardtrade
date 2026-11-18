import asyncio
import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_discovery import database, HTML
from agents.supplier_discovery import storage as discovery
from agents.supplier_discovery.extraction import extract
from agents.supplier_qualification import storage, workflow, gemini, research
from agents.supplier_qualification.models import Evidence, Extraction, CompareRequest, PriceReference
from agents.supplier_qualification.comparison import compare
from agents.supplier_qualification.verification import verify
from main import app

SPEC = {'packaging_type': 'carton', 'dimensions_mm': '100 x 200 x 300', 'material': 'kraft',
        'flute': 'B', 'ply': '3', 'printing': 'none', 'finishing': 'none'}
STAMP = '2026-01-01T00:00:00Z'


@pytest.fixture
def qualification(database):
    storage.migrate()
    with discovery.connection() as conn:
        conn.execute('UPDATE qualification_settings SET auto_enabled=0')
    data, evidence = extract(HTML, 'https://fixture.invalid/')
    with discovery.connection() as conn:
        lead_id, _ = discovery.save_lead(conn, data, 'fixture-qualification', 'Automated Discovery', evidence, url=data['website'])
    return lead_id


def reference(amount='100', currency='PKR', **changes):
    data = {'description': 'Kraft carton', 'specification': SPEC, 'amount': amount, 'currency': currency,
            'pieces_per_unit': 10, 'moq': 100, 'tier_min': 100, 'tier_max': 2000, 'channel': 'wholesale',
            'price_kind': 'advertised', 'source_url': 'https://fixture.invalid/prices',
            'source_quote': 'Kraft carton 100 x 200 x 300 mm, B flute, 3 ply, no printing, no finishing. PKR 100 per 10 pieces. MOQ 100.',
            'observed_at': STAMP, 'evidence_id': 'price-page'}
    data.update(changes)
    return PriceReference.model_validate(data).model_dump(mode='json')


def test_decimal_comparison_and_mismatches():
    request = CompareRequest(specification=SPEC, quantity=1000)
    result = compare(request, [{'id': 1, 'reference': reference()}, {'id': 2, 'reference': reference('120', source_url='https://other.invalid/prices')}])
    assert result['status'] == 'Comparable Data Available'
    assert Decimal(result['range']['low']) == Decimal('10')
    assert result['matched'][0]['missing_cost_components'] == ['shipping', 'tax', 'other_cost']
    variants = [reference(specification={**SPEC, 'ply': '5'}), reference(moq=None), reference(tier_min=2001, tier_max=3000),
                reference(channel='retail'), reference(price_kind='estimated'), reference(currency='USD'),
                reference(specification={**SPEC, 'dimensions_mm': ''})]
    result = compare(request, [{'id': i, 'reference': r} for i, r in enumerate(variants)])
    assert result['status'] == 'Insufficient Comparable Data'
    assert len(result['excluded']) == len(variants)
    assert not result['matched']


def test_same_listing_does_not_create_multiple_market_benchmarks():
    request = CompareRequest(specification=SPEC, quantity=1000)
    records = [{'id': 1, 'reference': reference()}, {'id': 2, 'reference': reference('120', observed_at='2026-02-01T00:00:00Z')}]
    result = compare(request, records)
    assert result['status'] == 'Insufficient Comparable Data'
    assert len(result['matched']) == 1
    assert result['matched'][0]['id'] == 2


def test_comparison_handles_extreme_valid_decimal_values():
    request = CompareRequest(specification=SPEC, quantity=1000, exchange_rates=[{
        'currency': 'USD', 'target_currency': 'PKR', 'rate': '9999999999.99999999', 'source_url': 'https://rates.invalid/', 'observed_at': STAMP}])
    result = compare(request, [{'id': 1, 'reference': reference('999999999999.999999', currency='USD')}])
    assert Decimal(result['matched'][0]['price_per_piece']) > 0
    tiny = compare(CompareRequest(specification=SPEC, quantity=1000), [{'id': 1, 'reference': reference('0.000001', pieces_per_unit=100000000)}])
    assert Decimal(tiny['matched'][0]['price_per_piece']) > 0


def test_sourced_fx_and_known_costs():
    request = CompareRequest(specification=SPEC, quantity=1000, exchange_rates=[{
        'currency': 'USD', 'target_currency': 'PKR', 'rate': '280', 'source_url': 'https://rates.invalid/', 'observed_at': STAMP}])
    result = compare(request, [{'id': 1, 'reference': reference('1', 'USD', shipping='10', tax='0', other_cost='0')}])
    assert Decimal(result['matched'][0]['price_per_piece']) == Decimal('28')
    assert Decimal(result['matched'][0]['known_total_per_piece']) == Decimal('30.8')
    assert result['matched'][0]['exchange_rate']['source_url'] == 'https://rates.invalid/'


def test_nonfinite_prices_rejected():
    for amount in ('NaN', 'Infinity', '-1', '0'):
        with pytest.raises(ValidationError):
            reference(amount)


def test_claim_evidence_validation():
    source = Evidence(id='one', url='https://fixture.invalid', observed_at=STAMP, kind='supplier', text='Fixture Packages manufactures cartons.')
    payload = Extraction(claims=[{'category': 'identity', 'value': 'Fixture Packages', 'evidence_id': 'one', 'quote': source.text}])
    assert gemini.validate_evidence(payload, [source])
    for change in ({'evidence_id': 'invented'}, {'quote': 'Invented source'}, {'value': 'Fake company'}):
        bad = payload.model_copy(deep=True)
        for field, value in change.items():
            setattr(bad.claims[0], field, value)
        with pytest.raises(ValueError):
            gemini.validate_evidence(bad, [source])
    with pytest.raises(ValidationError):
        Extraction.model_validate({'unsupported_summary': 'No source'})


def test_claims_independent_support_and_conflicts():
    lead = {'company': 'Fixture Packages', 'city': 'Lahore', 'email': '', 'phone': '', 'products': ['cartons']}
    supplier = Evidence(id='one', url='https://fixture.invalid/', observed_at=STAMP, kind='supplier',
                        text='Fixture Packages manufactures cartons in Lahore. ISO certified.', fields={'company': 'Fixture Packages', 'city': 'Lahore'})
    report = verify(lead, [supplier])
    assert report['findings'][0]['result'] == 'Partially Supported'
    assert next(f for f in report['findings'] if f['category'] == 'certification')['result'] == 'Partially Supported'
    independent = supplier.model_copy(update={'id': 'two', 'kind': 'independent', 'url': 'https://independent.invalid/'})
    report = verify(lead, [supplier, independent])
    assert report['findings'][0]['result'] == 'Supported'
    assert next(f for f in report['findings'] if f['category'] == 'manufacturing')['result'] == 'Partially Supported'
    contradiction = independent.model_copy(update={'fields': {'city': 'Karachi'}})
    assert next(f for f in verify(lead, [supplier, contradiction])['findings'] if f['category'] == 'address')['result'] == 'Conflicting'
    wrong_name = supplier.model_copy(update={'fields': {'company': 'Completely Different'}})
    assert verify(lead, [wrong_name])['findings'][0]['result'] == 'Conflicting'
    snippet = independent.model_copy(update={'kind': 'search'})
    assert verify(lead, [snippet])['findings'][0]['result'] == 'Partially Supported'


def test_directory_navigation_cannot_corroborate_products_or_conflict_with_location():
    text = 'Karachi navigation. Fixture Packages is listed in Packaging & Printing, located in Lahore Pakistan. Business Name Fixture Packages City Lahore Share: Packaging Machinery For Corrugated Cartons Boxes'
    excerpt = research.company_context(text, 'Fixture Packages')
    source = Evidence(id='directory',url='https://fixture.invalid/',kind='independent',observed_at=STAMP,
                      text=text,fields={'city':'Karachi','verification_excerpt':excerpt})
    report = verify({'company':'Fixture Packages','city':'Lahore','products':['corrugated','cartons','boxes']},[source])
    assert next(f for f in report['findings'] if f['category']=='address')['result']=='Supported'
    assert next(f for f in report['findings'] if f['category']=='products')['result']=='Unverified'


def test_supplier_transfer_persistence_idempotence_and_rule_fallback(qualification):
    payload = {'research': False, 'search': False, 'ai': True, 'source_urls': []}
    first, reused = workflow.create_job('verification', payload, 'test', qualification)
    assert not reused
    asyncio.run(workflow.run_job(first))
    second, reused = workflow.create_job('verification', payload, 'test', qualification)
    assert reused and first == second
    with discovery.connection() as conn:
        job = storage.decoded(conn.execute('SELECT * FROM qualification_jobs WHERE id=?', (first,)).fetchone())
        assert job['status'] == 'Completed'
        assert job['report']['ai']['status'] == 'Unavailable'
        assert job['report']['evidence'][0]['url'] == 'https://fixture.invalid/'
        assert job['report']['comparison']['status'] == 'Insufficient Comparable Data'
        assert conn.execute('SELECT status FROM discovery_leads WHERE id=?', (qualification,)).fetchone()[0] == 'Pending Review'
        assert conn.execute('SELECT count(*) FROM qualification_evidence').fetchone()[0] == 1


def fake_client(response=None, error=None):
    api = MagicMock()
    api.models.list.return_value = [SimpleNamespace(name='models/gemini-3.5-flash-lite', supported_actions=['generateContent']),
                                    SimpleNamespace(name='models/gemini-image-flash', supported_actions=['generateContent'])]
    api.models.generate_content.side_effect = error
    api.models.generate_content.return_value = response or SimpleNamespace(text='{"ok": true}', usage_metadata=SimpleNamespace(prompt_token_count=8, candidates_token_count=4, thoughts_token_count=0))
    context = MagicMock()
    context.__enter__.return_value = api
    return context, api


def test_only_key_one_probe_once(qualification, monkeypatch):
    monkeypatch.setattr(gemini, 'settings', lambda: {'GEMINI_API_KEY_1': 'secret-one', 'GEMINI_API_KEY_2': 'forbidden-key'})
    context, api = fake_client()
    with patch.object(gemini, 'client', return_value=context):
        assert gemini.probe()['status'] == 'Passed'
        assert gemini.probe()['previous_probe_reused']
    assert api.models.generate_content.call_count == 1
    assert gemini.credential() == 'secret-one'
    assert gemini.select_model(api) == 'models/gemini-3.5-flash-lite'


def test_quota_failure_no_rotation_and_error_redaction(qualification, monkeypatch):
    monkeypatch.setattr(gemini, 'settings', lambda: {'GEMINI_API_KEY_1': 'secret-one', 'GEMINI_API_KEY_2': 'forbidden-key'})
    context, api = fake_client(error=RuntimeError('429 RESOURCE_EXHAUSTED quota secret-one'))
    with patch.object(gemini, 'client', return_value=context):
        result = gemini.probe()
        assert result['status'] == 'Unavailable'
        assert 'RESOURCE_EXHAUSTED' in result['reason']
        assert 'secret-one' not in json.dumps(result)
        source = Evidence(id='one',url='https://fixture.invalid/',observed_at=STAMP,kind='supplier',text='Fixture Packages')
        assert gemini.analyze(5, [source], 'market')['status'] == 'Unavailable'
    assert api.models.generate_content.call_count == 1


def test_mocked_structured_extraction_cache_and_usage(qualification, monkeypatch):
    monkeypatch.setattr(gemini, 'settings', lambda: {'GEMINI_API_KEY_1': 'fake'})
    source = Evidence(id='one', url='https://fixture.invalid/', observed_at=STAMP, kind='supplier', text='Fixture Packages manufactures cartons.')
    payload = Extraction(claims=[{'category': 'identity', 'value': 'Fixture Packages', 'evidence_id': 'one', 'quote': source.text}])
    response = SimpleNamespace(text=json.dumps({'facts': [{'kind': 'claim', **claim.model_dump()} for claim in payload.claims]}), usage_metadata=SimpleNamespace(prompt_token_count=100, candidates_token_count=20, thoughts_token_count=0))
    context, api = fake_client(response)
    with discovery.connection() as conn:
        conn.execute("INSERT INTO qualification_ai_usage(purpose,model,status,created_at) VALUES('live-probe','models/gemini-3.5-flash-lite','Passed',?)", (discovery.now(),))
    with patch.object(gemini, 'client', return_value=context):
        result = gemini.analyze(1, [source])
        assert result['status'] == 'Available', result
        assert not result['cached']
        assert gemini.analyze(2, [source])['cached']
    assert api.models.generate_content.call_count == 1
    with discovery.connection() as conn:
        usage = conn.execute("SELECT * FROM qualification_ai_usage WHERE purpose='analysis-result'").fetchone()
        assert usage['input_tokens'] == 100 and usage['output_tokens'] == 20
        assert Decimal(usage['estimated_cost_usd']) > 0


def test_malformed_ai_output_falls_back(qualification, monkeypatch):
    monkeypatch.setattr(gemini, 'settings', lambda: {'GEMINI_API_KEY_1': 'fake'})
    with discovery.connection() as conn:
        conn.execute("INSERT INTO qualification_ai_usage(purpose,model,status,created_at) VALUES('live-probe','models/gemini-3.5-flash-lite','Passed',?)", (discovery.now(),))
    context, api = fake_client(SimpleNamespace(text='not json', usage_metadata=None))
    with patch.object(gemini, 'client', return_value=context):
        result = gemini.analyze(9, [Evidence(id='one',url='https://fixture.invalid/',observed_at=STAMP,kind='supplier',text='Fixture Packages')])
    assert result['status'] == 'Unavailable' and result['analysis'] is None


def test_official_sdk_serializes_extraction_schema_without_network():
    import httpx
    from google import genai
    from google.genai import types
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'text': '{}'}], 'role': 'model'}, 'finishReason': 'STOP'}]})

    with genai.Client(api_key='fake-key', http_options=types.HttpOptions(
        client_args={'transport': httpx.MockTransport(handler)})) as api:
        response = api.models.generate_content(model='gemini-test-flash', contents='Fixture only',
            config=types.GenerateContentConfig(temperature=0, max_output_tokens=1800,
                response_mime_type='application/json', response_json_schema=gemini.extraction_schema('supplier')))
    assert response.text == '{}'
    assert requests[0]['generationConfig']['responseJsonSchema']['properties']['facts']


def test_model_selection_prefers_newest_stable_low_cost_model():
    api = MagicMock()
    api.models.list.return_value = [SimpleNamespace(name=name, supported_actions=['generateContent']) for name in (
        'models/gemini-2.5-flash-lite', 'models/gemini-3.5-flash-lite', 'models/gemini-4.0-flash-preview',
        'models/gemini-3.5-flash-image', 'models/gemini-3.5-flash')]
    assert gemini.select_model(api) == 'models/gemini-3.5-flash-lite'


def test_admin_api_review_and_no_automatic_vendor_approval(qualification):
    with TestClient(app) as client:
        assert client.get('/api/v1/qualification/summary').status_code == 401
        client.cookies.set('cp_session', 'sales-token')
        assert client.get('/api/v1/qualification/suppliers').status_code == 403
        client.cookies.set('cp_session', 'admin-token')
        assert client.post('/api/v1/qualification/automation', json={'enabled': False, 'batch_size': 2}).status_code == 200
        response = client.post(f'/api/v1/qualification/suppliers/{qualification}/evaluate', json={'ai': False})
        assert response.status_code == 202
        job_id = response.json()['id']
        assert client.get(f'/api/v1/qualification/jobs/{job_id}').json()['status'] == 'Completed'
        assert client.post(f'/api/v1/qualification/jobs/{job_id}/review', json={'status': 'Reviewed', 'note': 'Evidence reviewed'}).status_code == 200
        assert client.post(f'/api/v1/qualification/jobs/{job_id}/review', json={'status': 'Approved', 'note': 'No'}).status_code == 422
        assert client.post(f'/api/v1/qualification/suppliers/{qualification}/evaluate', json={}, headers={'origin': 'https://evil.invalid'}).status_code == 403
        assert client.post('/api/v1/qualification/market/compare', json={'specification': SPEC, 'quantity': 1000}).json()['status'] == 'Insufficient Comparable Data'
    with discovery.connection() as conn:
        assert conn.execute('SELECT count(*) FROM vendors').fetchone()[0] == 0
        assert conn.execute('SELECT status FROM discovery_leads WHERE id=?', (qualification,)).fetchone()[0] == 'Pending Review'


def test_automatic_queue_small_batch_no_live_calls(qualification):
    with discovery.connection() as conn:
        conn.execute('UPDATE qualification_settings SET auto_enabled=1,batch_size=1')
    with patch.object(research, 'research', side_effect=AssertionError('Automatic queue must reuse evidence')), patch.object(gemini, 'analyze', side_effect=AssertionError('Automatic queue must not spend AI tokens')):
        asyncio.run(workflow.queue_tick())
        asyncio.run(workflow.queue_tick())
    with discovery.connection() as conn:
        assert conn.execute('SELECT count(*) FROM qualification_jobs').fetchone()[0] == 1


def test_automatic_queue_reuses_manual_evaluation_when_evidence_is_unchanged(qualification):
    job_id, _ = workflow.create_job('verification', {'ai': True, 'research': False}, 'admin', qualification)
    asyncio.run(workflow.run_job(job_id))
    with discovery.connection() as conn:
        conn.execute('UPDATE qualification_settings SET auto_enabled=1,batch_size=2')
    asyncio.run(workflow.queue_tick())
    with discovery.connection() as conn:
        assert conn.execute('SELECT count(*) FROM qualification_jobs').fetchone()[0] == 1


def test_guarded_research_reuses_exact_search_provider(qualification):
    fake = [{'url': 'https://independent.invalid/', 'title': 'Fixture Packages', 'snippet': 'Public company reference'}]
    async def search(filters):
        return 'query', fake
    with patch.object(research, 'duckduckgo_search', side_effect=search), patch.object(research, 'permitted_page', side_effect=ValueError('robots denied')):
        sources, errors = asyncio.run(research.research({'keywords': 'Fixture Packages'}, search_enabled=True))
    assert len(sources) == 1 and sources[0].kind == 'search'
    assert any('robots denied' in error for error in errors)


def test_structured_market_extraction():
    product = {'@type': 'Product', 'name': 'Kraft carton', 'additionalProperty': [{'name': k, 'value': v} for k, v in {**SPEC, 'channel': 'wholesale'}.items()],
               'offers': {'price': '100', 'priceCurrency': 'PKR', 'eligibleQuantity': {'minValue': 100}, 'priceSpecification': {'referenceQuantity': {'value': 10, 'unitCode': 'C62'}}}}
    html = '<script type="application/ld+json">' + json.dumps(product) + '</script><p>PKR 100 per 10 pieces</p>'
    values = research.structured_prices(html, 'https://fixture.invalid/prices', 'PKR 100 per 10 pieces', STAMP, 'page-1')
    assert len(values) == 1
    assert values[0]['amount'] == '100'
    assert values[0]['specification'] == SPEC
    assert not research.structured_prices(html, 'https://fixture.invalid/', 'No visible price', STAMP, 'page-1')


def test_published_price_ranges_are_observations_without_invented_variants():
    source = Evidence(id='range', url='https://fixture.invalid/', observed_at=STAMP, kind='independent',
                      text='Corrugated box variants ₨ 110 – ₨ 1,470. 3 ply and 5 ply. Several sizes.')
    observations = research.price_observations([source])
    assert observations[0]['published_price'] == '₨ 110 – ₨ 1,470'
    assert observations[0]['quote'] in source.text
    assert 'amount' not in observations[0]
    assert not research.price_observations([source.model_copy(update={'kind': 'search'})])


def test_market_job_and_admin_evidence_validation(qualification):
    source = Evidence(id='price-page', url='https://fixture.invalid/prices', kind='independent', observed_at=STAMP,
                      text=reference()['source_quote'], fields={'price_references': [reference()]})
    async def collect(*args):
        return [source], []
    with patch.object(research, 'research', side_effect=collect):
        job_id, _ = workflow.create_job('market', {'research': True, 'search': False, 'ai': False, 'query': 'cartons', 'comparison': {'specification': SPEC, 'quantity': 1000}}, 'test')
        asyncio.run(workflow.run_job(job_id))
    with TestClient(app) as client:
        client.cookies.set('cp_session', 'admin-token')
        assert len(client.get('/api/v1/qualification/market/prices').json()['items']) == 1
        bad = reference('500', source_quote='Invented quotation')
        assert client.post('/api/v1/qualification/market/prices', json={'job_id': job_id, 'reference': bad}).status_code == 422
        unsupported_spec = reference(specification={**SPEC, 'material': 'plastic'})
        assert client.post('/api/v1/qualification/market/prices', json={'job_id': job_id, 'reference': unsupported_spec}).status_code == 422
        assert client.post('/api/v1/qualification/market/prices', json={'job_id': job_id, 'reference': reference()}).status_code == 201
        assert client.get(f'/api/v1/qualification/jobs/{job_id}').json()['report']['comparison']['status'] == 'Insufficient Comparable Data'
