from fastapi.testclient import TestClient
from main import app


def test_implemented_supplier_registry_does_not_advertise_demo_or_production():
    agents = {a['id']: a for a in TestClient(app).get('/api/v1/agents').json()['agents']}
    for agent_id in ('supplier-catalog', 'supplier-stock'):
        agent = agents[agent_id]
        assert agent['status'] == 'implemented-development'
        assert agent['mode'] == 'development'
        assert agent['metrics'] == {}
    assert agents['supplier-discovery']['mode'] == 'live'
    assert agents['supplier-qualification']['mode'] == 'live'
    assert agents['buyer-discovery']['mode'] == 'demo'
