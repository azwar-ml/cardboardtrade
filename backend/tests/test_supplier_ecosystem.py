"""Cross-agent identity, eligibility and audit regressions on disposable SQLite."""
import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from test_discovery import database, HTML
from agents.supplier_discovery import storage, extraction
from agents.supplier_qualification import storage as qualification, workflow as qflow
from agents.supplier_catalog_intake import storage as catalog, workflow as cflow
from agents.supplier_stock_monitor import storage as stock, domain
from main import app


@pytest.fixture
def ecosystem(database):
    qualification.migrate(); catalog.migrate(); stock.migrate()
    with storage.connection() as c:
        c.execute('UPDATE discovery_schedule SET enabled=0')
        c.execute('UPDATE qualification_settings SET auto_enabled=0')
        c.execute("INSERT INTO vendors(id,code,name,status,email) VALUES(1,'FIX','Fixture Packages','active','business@fixture.invalid'),(2,'OTHER','Other Supplier','prospect','other@fixture.invalid')")
        lead,_=storage.save_lead(c,*[extraction.extract(HTML,'https://fixture.invalid/')[0], 'cross-agent-fixture', 'Automated Discovery', {'text_excerpt':'Fixture Packages manufactures carton boxes in Lahore Pakistan.'}])
    return lead


def client(): return TestClient(app,cookies={'cp_session':'admin-token'})


def test_link_for_qualification_survives_all_review_transitions(ecosystem):
    lead=ecosystem;c=client();url=f'/api/v1/discovery/leads/{lead}/review'
    assert c.post(url,json={'action':'review','linked_vendor_id':999}).status_code==404
    assert c.post(url,json={'action':'review','linked_vendor_id':1,'note':'Admin matched identity'}).status_code==200
    for action in ('reopen','review','dismiss','reopen','review'):
        assert c.post(url,json={'action':action}).status_code==200
        assert c.get(f'/api/v1/discovery/leads/{lead}').json()['linked_vendor_id']==1
    assert c.get('/api/v1/qualification/suppliers').json()['items'][0]['id']==lead
    with storage.connection() as conn:
        assert conn.execute('SELECT status FROM vendors WHERE id=1').fetchone()[0]=='active'
        assert conn.execute('SELECT count(*) FROM items').fetchone()[0]==0
        assert conn.execute('SELECT count(*) FROM discovery_activity WHERE lead_id=?',(lead,)).fetchone()[0]>=7


def test_qualification_review_history_and_eligibility_propagate(ecosystem):
    c=client();lead=ecosystem
    c.post(f'/api/v1/discovery/leads/{lead}/review',json={'action':'review','linked_vendor_id':1})
    job,_=qflow.create_job('verification',{'ai':False},'admin@test.invalid',lead)
    asyncio.run(qflow.run_job(job))
    with storage.connection() as conn:
        report={'findings':[{'category':'identity','result':'Supported'}], 'summary':'SIMULATED test evidence'}
        conn.execute('UPDATE qualification_jobs SET report=? WHERE id=?',(json.dumps(report),job))
        conn.execute('INSERT INTO stock_policies(vendor_id,enabled,updated_at) VALUES(1,1,?)',(storage.now(),))
    for status,eligible in [('Reviewed',True),('Rejected',False),('Documents Requested',False),('Reviewed',True)]:
        assert c.post(f'/api/v1/qualification/jobs/{job}/review',json={'status':status,'note':'SIMULATED Admin '+status}).status_code==200
        with storage.connection() as conn:assert bool(not domain.eligibility(conn,1))==eligible
    with storage.connection() as conn:
        history=[json.loads(r[0]) for r in conn.execute("SELECT detail FROM discovery_activity WHERE action='Qualification review' ORDER BY id")]
        assert len(history)==4 and history[1]['before']=='Reviewed' and history[1]['after']=='Rejected'
        assert all(h['qualification_job_id']==job for h in history)


def test_concurrent_imports_and_atomic_publication_rollback(ecosystem):
    c=client();content=b'SKU,Product name,Category\nONE,One carton,Shipping Box\nTWO,Two carton,Shipping Box\n'
    def upload(_):
        response=client().post('/api/v1/catalog/imports',data={'vendor_id':'1'},files={'file':('cross.csv',content,'text/csv')})
        assert response.status_code==200,response.text
        return response.json()['id']
    with ThreadPoolExecutor(max_workers=4) as pool:ids=list(pool.map(upload,range(4)))
    assert len(set(ids))==1
    job=ids[0];asyncio.run(cflow.run_job(job));rows=c.get('/api/v1/catalog/rows',params={'job':job}).json()['rows']
    assert len(rows)==2
    payload={'ids':[r['id'] for r in rows],'action':'approve','note':'SIMULATED source review'}
    assert c.post(f'/api/v1/catalog/imports/{job}/review',json=payload).status_code==200
    with pytest.raises(RuntimeError):
        with storage.connection() as conn:
            conn.execute('BEGIN IMMEDIATE');cflow.publish(conn,job,payload['ids'],1)
            raise RuntimeError('Simulated interrupted transaction')
    with storage.connection() as conn:
        assert conn.execute('SELECT count(*) FROM catalog_products').fetchone()[0]==0
        assert conn.execute("SELECT count(*) FROM catalog_rows WHERE status='Approved'").fetchone()[0]==2
    payload['action']='publish';assert c.post(f'/api/v1/catalog/imports/{job}/review',json=payload).status_code==200
    with storage.connection() as conn:
        conn.execute('INSERT INTO stock_policies(vendor_id,enabled,updated_at) VALUES(1,1,?)',(storage.now(),));domain.sync_watch(conn)
        assert conn.execute('SELECT count(*) FROM stock_watch WHERE vendor_id=1 AND catalog_id IS NOT NULL').fetchone()[0]==2
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    assert c.post(f'/api/v1/catalog/imports/{job}/review',json=payload).status_code==409


def test_activity_pagination_exposes_history_without_processing_jobs(ecosystem):
    with storage.connection() as conn:
        for i in range(45):stock.audit(conn,1,'Pagination fixture '+str(i),{})
    first=client().get('/api/v1/stock/activity?page=1').json()
    second=client().get('/api/v1/stock/activity?page=2').json()
    third=client().get('/api/v1/stock/activity?page=3').json()
    assert first['total']==45 and len(first['audit'])==20
    assert len(second['audit'])==20 and len(third['audit'])==5
    assert len({row['id'] for data in (first,second,third) for row in data['audit']})==45
