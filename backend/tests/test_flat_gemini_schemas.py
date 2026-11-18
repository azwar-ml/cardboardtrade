import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from test_discovery import database
from test_qualification import qualification, fake_client, STAMP
from test_gemini_workloads import configured
from agents.supplier_qualification import gemini, gemini_schemas
from agents.supplier_qualification.models import Evidence


def supplier_source():
    return Evidence(id='supplier', url='https://supplier.invalid/', observed_at=STAMP, kind='independent',
                    text='Fixture Packages is located in Lahore.')


def supplier_json(**changes):
    fact = {'kind': 'claim', 'category': 'identity', 'value': 'Fixture Packages',
            'evidence_id': 'supplier', 'quote': supplier_source().text}
    fact.update(changes)
    return json.dumps({'facts': [fact]})


def market_item(**changes):
    item = {name: '' for name in gemini_schemas.MarketItem.model_fields}
    item.update(evidence_id='market', description='Kraft carton', price_text='PKR 100',
        quote='Kraft carton 100x200x300 kraft B flute 3 ply no printing no finishing wholesale PKR 100 per 10 pieces MOQ 100.')
    item.update(changes)
    return item


def market_source(item):
    return Evidence(id='market',url='https://market.invalid/product',observed_at=STAMP,kind='supplier',text=item['quote'])


def test_flat_supplier_adapts_to_existing_claim_models_and_evidence_labels():
    source = supplier_source()
    payload = gemini_schemas.parse(supplier_json(), 'supplier', [source])
    gemini.validate_evidence(payload, [source])
    assert payload.claims[0].value == 'Fixture Packages'
    assert source.kind == 'independent' and source.observed_at == STAMP
    assert not payload.prices


def test_flat_market_preserves_range_without_inventing_comparable_price():
    item = market_item(price_text='PKR 110–1470', quote='Kraft carton PKR 110–1470 across several sizes.')
    source = market_source(item)
    payload = gemini_schemas.parse(json.dumps({'items':[item]}),'market',[source])
    gemini.validate_evidence(payload,[source])
    assert payload.market_summary[0].value == 'PKR 110–1470'
    assert payload.product_matches[0].value == 'Kraft carton'
    assert payload.prices == []


def test_flat_complete_price_receives_authoritative_url_and_observation_date():
    item = market_item(packaging_type='carton',dimensions_mm='100x200x300',material='kraft',flute='B',ply='3',
        printing='',finishing='',amount='100',currency='PKR',pieces_per_unit='10',moq='100',channel='wholesale')
    source = market_source(item)
    payload = gemini_schemas.parse(json.dumps({'items':[item]}),'market',[source])
    gemini.validate_evidence(payload,[source])
    price = payload.prices[0]
    assert str(price.amount) == '100'
    assert str(price.source_url) == source.url
    assert price.observed_at == source.observed_at
    assert price.shipping is None and price.tax is None
    assert price.specification.printing == ''


@pytest.mark.parametrize('changes', [{'evidence_id':'invented'}, {'quote':'Invented quote'}, {'currency':'USD'}, {'amount':'999'}, {'source_url':'https://invented.invalid/'}])
def test_flat_market_rejects_unquoted_or_invented_fields(changes):
    item = market_item()
    source = market_source(item)
    item.update(changes)
    with pytest.raises((ValidationError,ValueError)):
        gemini_schemas.parse(json.dumps({'items':[item]}),'market',[source])


@pytest.mark.parametrize('changes', [{'kind':'approval'},{'category':'approved'},{'value':42},{'extra':'invented'}])
def test_flat_supplier_rejects_malformed_facts(changes):
    with pytest.raises(ValidationError):
        gemini_schemas.parse(supplier_json(**changes),'supplier',[supplier_source()])


@pytest.mark.parametrize('workload', ['supplier','market'])
@pytest.mark.parametrize('message', ['400 INVALID_ARGUMENT too many schema states','403 PERMISSION_DENIED','429 RESOURCE_EXHAUSTED'])
def test_provider_errors_fall_back_without_retries_or_other_keys(configured,workload,message):
    context, api = fake_client(error=RuntimeError(message))
    with patch.object(gemini,'client',return_value=context) as clients:
        result = gemini.analyze(1700,[supplier_source()],workload)
        assert result['status']=='Unavailable' and message in result['reason']
        assert gemini.analyze(1701,[supplier_source()],workload)['status']=='Unavailable'
    assert api.models.generate_content.call_count==1
    assert all(call.args==(workload,) for call in clients.call_args_list)


@pytest.mark.parametrize('workload', ['supplier','market'])
@pytest.mark.parametrize('text', ['not json','{}','[]'])
def test_malformed_wire_json_leaves_fallback_available(configured,workload,text):
    response = SimpleNamespace(text=text,usage_metadata=None)
    context, api = fake_client(response)
    with patch.object(gemini,'client',return_value=context):
        result = gemini.analyze(1800,[supplier_source()],workload)
    assert result['status']=='Unavailable' and result['analysis'] is None
    assert api.models.generate_content.call_count==1
