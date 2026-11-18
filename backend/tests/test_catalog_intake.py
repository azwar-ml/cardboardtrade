import asyncio
import io
import json
import zipfile
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from test_discovery import database
from agents.supplier_qualification.storage import migrate as qualification_migrate
from agents.supplier_catalog_intake import api, storage, workflow, parsers, ai
from agents.supplier_catalog_intake.normalization import normalize, header_mapping, identity
from main import app


@pytest.fixture
def catalog(database,monkeypatch):
    monkeypatch.setenv('CATALOG_ALLOW_DEMO_INPUT','true')
    directory = database / '.qa-catalog'
    directory.mkdir()
    with sqlite3.connect(database / 'trade.db') as original, sqlite3.connect(directory / 'trade.db') as target:
        original.backup(target)
    monkeypatch.setenv('TRADE_DATA_DIR', str(directory))
    qualification_migrate()
    storage.migrate()
    with storage.connection() as conn:
        conn.execute("INSERT INTO vendors(id,code,name,status) VALUES(1,'QA','QA Supplier','prospect'),(2,'QB','Other Supplier','onboarding')")
    return directory


def client():
    return TestClient(app, cookies={'cp_session': 'admin-token'})


def source(text=None):
    return (text or 'SKU,Product name,Category,Length,Width,Height,Unit,Price,Currency,Pricing unit\nA,Carton,Shipping Box,12,10,8,in,20,PKR,piece\n').encode()


def upload(content=None, name='source.csv', vendor=1):
    response = client().post('/api/v1/catalog/imports', data={'vendor_id': vendor}, files={'file': (name, content or source())})
    assert response.status_code == 200, response.text
    return response.json()['id']


def run(job):
    asyncio.run(workflow.run_job(job))
    return client().get('/api/v1/catalog/rows', params={'job': job}).json()['rows']


def review(job, ids, action):
    return client().post(f'/api/v1/catalog/imports/{job}/review', json={'ids': ids, 'action': action, 'note': 'Fixture Admin review'})


def test_complete_workflow_and_persistence(catalog):
    job = upload()
    row = run(job)[0]
    assert row['data']['length_mm'] == '304.8' and row['data']['qty'] is None
    assert row['source']['row'] == 2 and row['source']['label'].startswith('Supplier claim')
    assert review(job,[row['id']],'publish').status_code == 409
    data = {**row['data'],'name':'Reviewed carton'}
    response = client().post(f"/api/v1/catalog/rows/{row['id']}/edit", json={'version':row['version'],'data':data,'reason':'Source checked'})
    assert response.status_code == 200
    assert review(job,[row['id']],'approve').status_code == 200
    assert review(job,[row['id']],'publish').status_code == 200
    storage.migrate(); workflow.recover()
    offers = client().get('/api/v1/catalog/products').json()['rows']
    assert offers[0]['data']['name'] == 'Reviewed carton'
    assert offers[0]['data']['qty'] is None and offers[0]['source']['job_id'] == job
    with storage.connection() as conn:
        assert conn.execute('SELECT count(*) FROM items').fetchone()[0] == 0
        assert conn.execute('SELECT status FROM vendors WHERE id=1').fetchone()[0] == 'prospect'
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert review(job,[row['id']],'publish').status_code == 409


def test_duplicate_import_and_same_sku_variations(catalog):
    content = source('SKU,Product name,Category,Length,Unit\nA,Carton,Shipping Box,12,in\nA,Carton,Shipping Box,12,in\nA,Carton,Shipping Box,13,in\n')
    job = upload(content)
    assert upload(content) == job
    rows = sorted(run(job),key=lambda r:r['ordinal'])
    assert rows[1]['errors'] and rows[1]['matches'][0]['type'] == 'Duplicate row in import'
    assert not rows[2]['errors']
    assert review(job,[rows[1]['id']],'approve').status_code == 409
    assert review(job,[rows[0]['id'],rows[2]['id']],'approve').status_code == 200
    assert review(job,[rows[0]['id'],rows[2]['id']],'publish').status_code == 200
    other = upload(content, vendor=2)
    assert len(run(other)) == 3


def test_transactional_bulk_publication(catalog):
    job = upload(source('SKU,Product name,Category\nA,One,Shipping Box\nB,Two,Shipping Box\n'))
    rows = run(job)
    assert review(job,[rows[0]['id']],'approve').status_code == 200
    assert review(job,[r['id'] for r in rows],'publish').status_code == 409
    assert client().get('/api/v1/catalog/products').json()['total'] == 0
    assert client().get('/api/v1/catalog/rows').json()['rows'][0]['status'] == 'Approved'


@pytest.mark.parametrize('unit,expected',[('inches','304.8'),('cm','120'),('m','12000'),('mm','12')])
def test_units_and_unknowns(unit,expected):
    raw={'Product name':'Box','Category':'Shipping Box','Length':'12','Unit':unit}
    data,errors,warnings=normalize(raw,header_mapping(raw),'2026-11-18T00:00:00Z')
    assert not errors and data['length_mm']==expected
    assert data['qty'] is None and data['price'] is None
    assert data['availability']=='Catalog only'


@pytest.mark.parametrize('changes',[{'Price':'NaN'},{'Price':'-2'},{'Stock':'-1'},{'Category':'Alien'},{'Ply':'9'},{'Unit':'furlong','Length':'12'},{'Price':'=2+2'}])
def test_reject_invalid_values(changes):
    raw={'Product name':'Box','Category':'Shipping Box','Price':'10','Currency':'PKR','Pricing unit':'piece',**changes}
    assert normalize(raw,header_mapping(raw),'2026-11-18')[1]


def workbook():
    b=Workbook();s=b.active;s.title='Products';s.append(['Ignore title']);s.append(['Product name','Category','Stock']);s.append(['Box','Shipping Box',None]);s.append([None,None,None])
    t=b.create_sheet('More');t.append(['SKU','Product name','Category','Length cm']);t.append(['B','Pizza carton','Pizza',30])
    output=io.BytesIO();b.save(output);return output.getvalue()


def test_multiple_sheets_and_formula_rejection(catalog):
    values,notes,_=parsers.parse(workbook(),'xlsx')
    assert len(values)==2 and values[0]['source']['row']==3
    job=upload(workbook(),'catalog.xlsx');rows=run(job)
    assert len(rows)==2


def test_mapping_missing_headers_and_csv_encoding(catalog):
    raw='Identifiant;Désignation;Gamme\nX;Boîte café;Shipping Box\n'.encode('cp1252')
    job=upload(raw)
    assert run(job)==[]
    response=client().post(f'/api/v1/catalog/imports/{job}/action',json={'action':'remap','mapping':{'Identifiant':'vendor_sku','Désignation':'name','Gamme':'line'}})
    assert response.status_code==200
    assert run(job)[0]['data']['name']=='Boîte café'
    with storage.connection() as conn: assert conn.execute('SELECT count(*) FROM catalog_mappings').fetchone()[0]==1


def pdf_bytes(lines=None):
    from pypdf import PdfWriter
    from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
    writer=PdfWriter();page=writer.add_blank_page(width=600,height=800)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Courier')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    stream=DecodedStreamObject(); text='BT /F1 10 Tf 20 750 Td '
    for line in lines or ['SKU    Product name    Category','P1     Shipping carton    Shipping Box']:
        text+='('+line+') Tj 0 -16 Td '
    stream.set_data((text+'ET').encode());page[NameObject('/Contents')]=writer._add_object(stream)
    output=io.BytesIO();writer.write(output);return output.getvalue()


def test_pdf_table_and_scanned_manual_review(catalog):
    rows,warnings,texts=parsers.parse(pdf_bytes(),'pdf')
    assert len(rows)==1 and rows[0]['source']['page']==1
    job=upload(pdf_bytes(),'catalog.pdf');assert len(run(job))==1
    from pypdf import PdfWriter
    output=io.BytesIO();writer=PdfWriter();writer.add_blank_page(width=300,height=300);writer.write(output)
    job=upload(output.getvalue(),'scan.pdf');assert run(job)==[]
    detail=client().get(f'/api/v1/catalog/imports/{job}').json()
    assert detail['status']=='Needs Review' and any('manual review' in w for w in detail['warnings'])


@pytest.mark.parametrize('name,content',[('x.exe',b'bad'),('x.xlsx',b'PKbad'),('x.pdf',b'notpdf'),('x.csv',b'\x00unsafe')])
def test_invalid_files(catalog,name,content):
    response=client().post('/api/v1/catalog/imports',data={'vendor_id':1},files={'file':(name,content)})
    assert response.status_code==422


def test_zip_bomb_limit():
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('bomb','0'*2000000)
    with pytest.raises(ValueError):parsers.check_file('bad.xlsx',output.getvalue())


def test_cancel_recover_and_decision_guards(catalog):
    job=upload()
    with storage.connection() as conn:conn.execute("UPDATE catalog_jobs SET status='Processing' WHERE id=?",(job,))
    workflow.recover()
    assert client().get(f'/api/v1/catalog/imports/{job}').json()['status']=='Queued'
    assert client().post(f'/api/v1/catalog/imports/{job}/action',json={'action':'cancel'}).status_code==200
    run(job)
    assert client().get(f'/api/v1/catalog/imports/{job}').json()['status']=='Cancelled'
    assert client().post(f'/api/v1/catalog/imports/{job}/action',json={'action':'retry'}).status_code==200
    row=run(job)[0];assert review(job,[row['id']],'correction').status_code==200
    assert review(job,[row['id']],'reject').status_code==200
    assert client().post(f'/api/v1/catalog/imports/{job}/action',json={'action':'retry'}).status_code==409


def test_authorization_all_sensitive_routes(catalog):
    routes=[('get','/summary'),('get','/options'),('get','/imports'),('get','/rows'),('get','/products'),('get','/export'),('get','/imports/abc/source'),('post','/controls'),('post','/imports'),('post','/url'),('post','/rows/1/edit'),('post','/imports/abc/review'),('post','/imports/abc/action')]
    for method,path in routes:
        assert getattr(TestClient(app),method)('/api/v1/catalog'+path).status_code==401
        assert getattr(TestClient(app,cookies={'cp_session':'sales-token'}),method)('/api/v1/catalog'+path).status_code==403


def test_ssrf_local_and_source_bytes(catalog):
    assert client().post('/api/v1/catalog/url',json={'vendor_id':1,'url':'http://127.0.0.1/private'}).status_code==422
    data=source();job=upload(data)
    response=client().get(f'/api/v1/catalog/imports/{job}/source')
    assert response.content==data
    assert 'stored_name' not in client().get(f'/api/v1/catalog/imports/{job}').json()


def test_website_tables_and_permitted_fetch_mock(catalog,monkeypatch):
    html='<table><tr><th>SKU</th><th>Product name</th><th>Category</th></tr><tr><td>A</td><td>Carton</td><td>Shipping Box</td></tr></table>'
    rows,_,_=parsers.parse_html(html,'https://supplier.invalid/products')
    assert rows[0]['source']['url'].startswith('https')
    async def fake(url,mapping,limit):return parsers.parse_html(html,url,limit,mapping)
    monkeypatch.setattr(workflow,'website',fake)
    job=api.create(1,'supplier.invalid','url',None,'https://supplier.invalid/products',{'id':1})['id']
    assert run(job)[0]['data']['name']=='Carton'


def test_real_afeef_fixture(catalog):
    file=Path(__file__).resolve().parents[2]/'deliverables/Example_filled_list_Afeef_Packages_DEMO.xlsx'
    job=upload(file.read_bytes(),file.name)
    rows=run(job)
    assert len(rows)==15 and not any(r['errors'] for r in rows)
    assert rows[0]['source']['worksheet']=='BULK_UPLOAD'


@pytest.mark.parametrize('code',[400,403,429,503])
def test_ai_errors_fallback_no_retry(catalog,monkeypatch,code):
    job=upload()
    monkeypatch.setattr(ai.provider,'settings',lambda:{'CATALOG_GEMINI_KEY_NAME':'GEMINI_API_KEY_4','CATALOG_GEMINI_FREE_TIER_CONFIRMED':'true','GEMINI_API_KEY_4':'fixture-secret'})
    fake=Mock();exc=RuntimeError(f'{code} fixture provider error');exc.code=code
    fake.models.generate_content.side_effect=exc
    monkeypatch.setattr('google.genai.Client',lambda **kwargs:fake)
    monkeypatch.setattr(ai.provider,'select_model',lambda api:'models/gemini-3.5-flash-lite')
    rows,error=ai.extract(job,[{'text':'Carton'}])
    assert rows==[] and str(code) in error and fake.models.generate_content.call_count==1
    ai.extract(job,[{'text':'Carton'}])
    assert fake.models.generate_content.call_count==1
    assert len(run(job))==1


@pytest.mark.parametrize('payload',[{'claims':[{'product':'Carton','field':'name','value':'Carton','quote':'Carton','source':0}]}, {'claims':[{'product':'Carton','field':'qty','value':'500','quote':'Carton stock 500','source':0}]}, {'claims':[{'product':'Carton','field':'magic','value':'yes','quote':'Carton','source':0}]}, {'unexpected':True}])
def test_ai_evidence_validation(catalog,monkeypatch,payload):
    job=upload()
    monkeypatch.setattr(ai.provider,'settings',lambda:{'CATALOG_GEMINI_KEY_NAME':'GEMINI_API_KEY_4','CATALOG_GEMINI_FREE_TIER_CONFIRMED':'true','GEMINI_API_KEY_4':'fixture-secret'})
    fake=Mock();fake.models.generate_content.return_value=SimpleNamespace(text=json.dumps(payload),usage_metadata=SimpleNamespace(prompt_token_count=20,candidates_token_count=10,thoughts_token_count=0))
    monkeypatch.setattr('google.genai.Client',lambda **kwargs:fake);monkeypatch.setattr(ai.provider,'select_model',lambda api:'models/gemini-3.5-flash-lite')
    rows,error=ai.extract(job,[{'text':'Carton'}])
    if payload['claims'][0]['field']=='name' if 'claims' in payload else False:
        assert rows and error is None
        assert ai.extract(job,[{'text':'Carton'}])[0]==rows
    else:assert not rows and error


def test_key_three_disabled_and_no_default_ai(catalog,monkeypatch):
    assert not ai.configuration()['enabled']
    monkeypatch.setattr(ai.provider,'settings',lambda:{'CATALOG_GEMINI_KEY_NAME':'GEMINI_API_KEY_3','CATALOG_GEMINI_FREE_TIER_CONFIRMED':'true','GEMINI_API_KEY_3':'fixture'})
    assert not ai.configuration()['enabled']


def test_reviewed_updates_only_change_selected_fields(catalog):
    job=upload();row=run(job)[0]
    assert review(job,[row['id']],'approve').status_code==200
    assert review(job,[row['id']],'publish').status_code==200
    product=client().get('/api/v1/catalog/products').json()['rows'][0]
    revised=upload(source().replace(b',20,PKR',b',21,PKR'))
    updated=run(revised)[0]
    assert updated['errors']
    assert review(revised,[updated['id']],'approve').status_code==409
    data={**updated['data'],'name':'Unapproved name change','price':'21'}
    result=client().post(f"/api/v1/catalog/rows/{updated['id']}/edit",json={'version':updated['version'],'data':data,'reason':'Reviewed quotation change','target_id':product['id'],'update_fields':['price']})
    assert result.status_code==200 and not result.json()['errors']
    assert review(revised,[updated['id']],'approve').status_code==200
    assert review(revised,[updated['id']],'publish').status_code==200
    products=client().get('/api/v1/catalog/products').json()
    assert products['total']==1 and products['rows'][0]['data']['price']=='21'
    assert products['rows'][0]['data']['name']==product['data']['name']


def test_stale_updates_and_optimistic_edits(catalog):
    job=upload();row=run(job)[0]
    data={**row['data'],'price':'22'}
    body={'version':row['version'],'data':data,'reason':'Reviewed correction'}
    assert client().post(f"/api/v1/catalog/rows/{row['id']}/edit",json=body).status_code==200
    assert client().post(f"/api/v1/catalog/rows/{row['id']}/edit",json=body).status_code==409
    assert review(job,[row['id']],'approve').status_code==200
    assert review(job,[row['id']],'publish').status_code==200
    product=client().get('/api/v1/catalog/products').json()['rows'][0]
    revised=upload(source().replace(b',20,PKR',b',23,PKR'));r=run(revised)[0]
    result=client().post(f"/api/v1/catalog/rows/{r['id']}/edit",json={'version':r['version'],'data':r['data'],'reason':'Reviewed update','target_id':product['id'],'update_fields':['price']})
    assert result.status_code==200
    assert review(revised,[r['id']],'approve').status_code==200
    with storage.connection() as conn:conn.execute("UPDATE catalog_products SET updated_at='2099-01-01' WHERE id=?",(product['id'],))
    assert review(revised,[r['id']],'publish').status_code==409


def test_demo_rejected_in_non_qa_and_unknown_source_vendor(catalog,monkeypatch):
    monkeypatch.delenv('CATALOG_ALLOW_DEMO_INPUT')
    job=upload(source('SKU,Product name,Category,Vendor,Notes\nA,Box,Shipping Box,Unknown Inc,DEMO fixture\n'))
    row=run(job)[0]
    assert len(row['errors'])==2
    result=client().post(f"/api/v1/catalog/rows/{row['id']}/edit",json={'version':row['version'],'data':row['data'],'reason':'Cannot remove source mismatch'})
    assert len(result.json()['errors'])==2
    assert review(job,[row['id']],'approve').status_code==409


def test_export_formula_escape_and_file_limits(catalog):
    job=upload(source('SKU,Product name,Category\nA,@unsafe,Shipping Box\n'))
    row=run(job)[0];assert review(job,[row['id']],'approve').status_code==200
    assert review(job,[row['id']],'publish').status_code==200
    assert "'@unsafe" in client().get('/api/v1/catalog/export').text
    assert client().post('/api/v1/catalog/controls',json={'paused':True,'max_rows':1,'max_file_mb':1}).status_code==200
    result=client().post('/api/v1/catalog/imports',data={'vendor_id':1},files={'file':('large.csv',b'x'*1048577)})
    assert result.status_code==413


def test_one_file_and_bounded_bodies(catalog):
    result=client().post('/api/v1/catalog/imports',data={'vendor_id':1},files=[('file',('a.csv',source())),('file',('b.csv',source()))])
    assert result.status_code==400
    result=client().post('/api/v1/catalog/controls',content=b' '*300000,headers={'content-type':'application/json'})
    assert result.status_code==413


def test_explicit_website_reobservation(catalog):
    first=api.create(1,'Catalog','url',None,'https://supplier.invalid/catalog',{'id':1})
    repeat=api.create(1,'Catalog','url',None,'https://supplier.invalid/catalog',{'id':1})
    fresh=api.create(1,'Catalog','url',None,'https://supplier.invalid/catalog',{'id':1},refresh=True)
    assert first['id']==repeat['id'] and fresh['id']!=first['id']
