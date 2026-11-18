"""Explicitly disposable Agent #4 fixture; never opens business data."""
import os
import sqlite3
from pathlib import Path
from agents.supplier_discovery import storage
from agents.supplier_qualification.storage import migrate as qualification_migrate
from agents.supplier_catalog_intake.storage import migrate as catalog_migrate
from agents.supplier_stock_monitor.storage import migrate as stock_migrate,dump
from agents.supplier_stock_monitor.domain import sync_watch


def prepare():
    directory=Path(os.environ['TRADE_DATA_DIR']).resolve()
    if not directory.name.startswith('.qa-stock-'):raise SystemExit('Use a new .qa-stock- disposable directory')
    file=directory/'trade.db'
    if not file.exists():raise SystemExit('Run frontend/scripts/prepare-disposable-qa.mjs first')
    schema=(Path(__file__).resolve().parents[1]/'frontend/lib/trade/db.ts').read_text(encoding='utf-8').split('const SCHEMA = `')[1].split('`;')[0]
    with sqlite3.connect(file) as c:
        c.executescript(schema)
        if c.execute('SELECT count(*) FROM vendors').fetchone()[0]:raise SystemExit('Refusing to reuse populated QA database')
    storage.migrate();qualification_migrate();catalog_migrate();stock_migrate()
    with storage.connection() as c:
        c.execute('UPDATE discovery_schedule SET enabled=0');c.execute('UPDATE qualification_settings SET auto_enabled=0')
        c.execute("INSERT INTO vendors(id,code,name,status,email,notes) VALUES(1,'QA-STOCK','QA Stock Supplier — SIMULATED','active','stock@fixture.invalid','Disposable mock evidence, not real supplier stock'),(2,'QA-NO','QA Unapproved Supplier','prospect','unknown@fixture.invalid','Disposable fixture')")
        c.execute("INSERT INTO discovery_leads(id,company,name_key,linked_vendor_id,source_type,discovered_at,updated_at) VALUES(1,'QA Stock Supplier','qastock',1,'Website Submission',?,?)",(storage.now(),storage.now()))
        report=dump({'summary':'SIMULATED qualification fixture, not independent commercial evidence','findings':[{'category':'identity','result':'Supported'}]})
        c.execute("INSERT INTO qualification_jobs(id,lead_id,kind,status,actor,input,fingerprint,created_at,report,review_status) VALUES(1,1,'verification','Completed','QA fixture','{}','qa-fixture',?,?,'Reviewed')",(storage.now(),report))
        c.execute("INSERT INTO stock_policies(vendor_id,enabled,updated_at) VALUES(1,1,?)",(storage.now(),))
        c.execute("INSERT INTO stock_contacts(id,vendor_id,name,email,confirmed,reference,created_at) VALUES(1,1,'QA Supplier Contact','stock@fixture.invalid',1,'SIMULATED verified contact fixture',?)",(storage.now(),))
        c.execute("INSERT INTO catalog_jobs(id,vendor_id,fingerprint,name,kind,status,created_by,created_at,updated_at) VALUES('qa-stock-fixture',1,'qa-stock-fixture','SIMULATED stock fixture','csv','Completed',1,?,?)",(storage.now(),storage.now()))
        for i in (1,2):
            data={'vendor_sku':'QA-BOARD-'+str(i),'name':'SIMULATED board fixture '+str(i),'line':'Shipping Box','qty':None,'price':None,'currency':None,'price_unit':None,'gsm':'300','availability':'Catalog only','observed_at':storage.now()}
            c.execute("INSERT INTO catalog_rows(id,job_id,ordinal,source,raw,data,identity,status) VALUES(?,'qa-stock-fixture',?,'{}','{}',?,?,'Published')",(i,i,dump(data),'qa-stock-'+str(i)))
            c.execute('INSERT INTO catalog_products(id,vendor_id,identity,data,source,row_id,created_at,updated_at) VALUES(?,1,?,?,?, ?,?,?)',(i,'qa-stock-'+str(i),dump(data),dump({'document':'SIMULATED stock fixture','label':'QA only','observed_at':storage.now()}),i,storage.now(),storage.now()))
        sync_watch(c)
    print('Disposable stock-monitor fixture prepared; zero real suppliers contacted')


if __name__=='__main__':prepare()
