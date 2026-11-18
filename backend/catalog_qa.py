"""Prepare an explicitly disposable catalog demo database; never opens business data."""
import os
import sqlite3
from pathlib import Path
from agents.supplier_discovery import storage
from agents.supplier_qualification.storage import migrate as qualification_migrate
from agents.supplier_catalog_intake.storage import migrate as catalog_migrate


def prepare():
    directory = Path(os.environ['TRADE_DATA_DIR']).resolve()
    if not directory.name.startswith('.qa-'):
        raise SystemExit('TRADE_DATA_DIR must be an explicitly disposable .qa- directory')
    filename = directory / 'trade.db'
    if not filename.exists(): raise SystemExit('Run frontend/scripts/prepare-disposable-qa.mjs first')
    schema = (Path(__file__).resolve().parents[1] / 'frontend/lib/trade/db.ts').read_text(encoding='utf-8').split('const SCHEMA = `')[1].split('`;')[0]
    with sqlite3.connect(filename) as conn:
        conn.executescript(schema)
        if conn.execute('SELECT count(*) FROM vendors').fetchone()[0]: raise SystemExit('Refusing to reuse populated QA data')
        conn.execute("INSERT INTO vendors(id,code,name,status,notes) VALUES(1,'QA-AFEEFP','Afeef Packages — DEMO input only','prospect','Disposable fixture, not commercial stock'),(2,'QA-OTHER','QA Other Supplier','onboarding','Disposable fixture')")
    storage.migrate(); qualification_migrate(); catalog_migrate()
    with storage.connection() as conn:
        # Only this newly created disposable DB. Real scheduler is never opened.
        conn.execute('UPDATE discovery_schedule SET enabled=0')
        conn.execute('UPDATE qualification_settings SET auto_enabled=0')
    print('Disposable catalog QA prepared')


if __name__ == '__main__': prepare()
