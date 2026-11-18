import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from pydantic import ValidationError
from test_discovery import database
from test_qualification import qualification, fake_client, STAMP
from test_gemini_workloads import configured
from agents.supplier_qualification import gemini, gemini_schemas, workflow
from agents.supplier_qualification.models import Evidence
from agents.supplier_discovery import storage


def source():
    return Evidence(id='recorded-label-test', url='https://fixture.invalid/', observed_at=STAMP,
                    kind='independent', text='Fixture Packages operates in Lahore Pakistan.')


def fact(label, value='Fixture Packages', **changes):
    result = {'kind': 'claim', 'category': label, 'value': value,
              'evidence_id': source().id, 'quote': source().text}
    result.update(changes)
    return result


def parse(facts):
    return gemini_schemas.parse(json.dumps({'facts': facts}), 'supplier', [source()])


def test_replay_all_three_recorded_category_failures():
    recorded = json.loads((Path(__file__).parent / 'fixtures/recorded_supplier_category_errors.json').read_text())
    values = {'Company Name': 'Fixture Packages', 'Country': 'Pakistan', 'City': 'Lahore'}
    facts = [fact(item['label'], values[item['label']]) for item in recorded['recorded_failures']]
    snapshot = copy.deepcopy(facts)
    evidence_before = source().model_dump()
    result = parse(facts)
    gemini.validate_evidence(result, [source()])
    assert [claim.category for claim in result.claims] == ['identity', 'address', 'address']
    assert [claim.value for claim in result.claims] == ['Fixture Packages', 'Pakistan', 'Lahore']
    assert all(claim.quote == source().text and claim.evidence_id == source().id for claim in result.claims)
    assert facts == snapshot and source().model_dump() == evidence_before
    assert recorded['raw_response_available'] is False


@pytest.mark.parametrize('label,canonical', [
    ('Company Name', 'identity'), ('company_name', 'identity'), (' COMPANY   NAME ', 'identity'),
    ('Country', 'address'), ('CITY', 'address'), (' Address ', 'address'),
    *[(label, label) for label in gemini_schemas.CATEGORIES],
])
def test_bounded_aliases_and_canonical_categories(label, canonical):
    assert parse([fact(label)]).claims[0].category == canonical


@pytest.mark.parametrize('label', ['approved', 'verified', 'risk', 'business name', 'company-name',
                                  'identity approved', 'country/code', '', ' ', None, 42, False, {}, []])
def test_unknown_or_unsupported_categories_are_rejected(label):
    with pytest.raises(ValidationError):
        parse([fact(label)])


@pytest.mark.parametrize('changes', [
    {'evidence_id': 'invented'}, {'quote': 'Unrelated source quote'}, {'value': 'Invented company'},
])
def test_normalization_never_bypasses_source_requirements(changes):
    result = parse([fact('Company Name', **changes)])
    with pytest.raises(ValueError):
        gemini.validate_evidence(result, [source()])


def test_compact_supplier_enum_matches_domain_and_prompt():
    schema = gemini.extraction_schema('supplier')
    category = schema['properties']['facts']['items']['properties']['category']
    assert category == {'type': 'string', 'enum': list(gemini_schemas.CATEGORIES)}
    assert len(category['enum']) == 8
    assert all(name in gemini_schemas.instructions('supplier') for name in category['enum'])
    assert 'identity for company or legal name' in gemini_schemas.instructions('supplier')
    assert 'address for city, country or postal address' in gemini_schemas.instructions('supplier')
    assert '$defs' not in json.dumps(schema)
    assert 'enum' not in json.dumps(gemini.extraction_schema('market'))


def test_official_sdk_serializes_the_compact_category_enum_without_network():
    from google import genai
    from google.genai import types
    requests = []
    text = json.dumps({'facts': [fact('identity')]})

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'text': text}], 'role': 'model'}, 'finishReason': 'STOP'}]})

    with genai.Client(api_key='fixture-only', http_options=types.HttpOptions(
        api_version='v1beta', retry_options=types.HttpRetryOptions(attempts=1),
        client_args={'transport': httpx.MockTransport(handler)})) as api:
        response = api.models.generate_content(model='models/gemini-3.5-flash-lite', contents='Offline fixture',
            config=gemini.generation_config('models/gemini-3.5-flash-lite', 256, gemini.extraction_schema('supplier')))
    result = gemini_schemas.parse(response.text, 'supplier', [source()])
    gemini.validate_evidence(result, [source()])
    assert len(requests) == 1
    assert requests[0]['generationConfig']['responseJsonSchema']['properties']['facts']['items']['properties']['category']['enum'] == list(gemini_schemas.CATEGORIES)


def test_equivalent_labels_validate_through_normal_analysis_entry_point(configured):
    response = SimpleNamespace(text=json.dumps({'facts': [fact('Company Name')]}), usage_metadata=None)
    context, api = fake_client(response)
    with patch.object(gemini, 'client', return_value=context):
        result = gemini.analyze(1900, [source()], 'supplier')
    assert result['status'] == 'Available'
    assert result['analysis']['claims'][0]['category'] == 'identity'
    assert api.models.generate_content.call_count == 1


def test_http_503_preserves_evidence_findings_and_manual_review(configured):
    with storage.connection() as conn:
        lead = dict(conn.execute('SELECT * FROM discovery_leads LIMIT 1').fetchone())
    lead['products'] = json.loads(lead['products'])
    context, api = fake_client(error=RuntimeError('503 UNAVAILABLE model high demand'))
    evidence = [source()]
    before = [item.model_dump() for item in evidence]
    with patch.object(gemini, 'client', return_value=context):
        report = asyncio.run(workflow.evaluate({'job': {'id': 1901, 'input': {'ai': True, 'ai_workloads': ['supplier']}},
                                               'lead': lead, 'evidence': evidence, 'errors': []}))['report']
    assert report['ai']['status'] == 'Unavailable' and '503' in report['ai']['reason']
    assert report['evidence'] == before
    assert len(report['findings']) == 8 and report['admin_approval_required'] is True
    assert api.models.generate_content.call_count == 1
