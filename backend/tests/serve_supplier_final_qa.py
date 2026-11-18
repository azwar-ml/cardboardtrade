"""Offline-only four-agent browser acceptance server; refuses business databases."""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
HTML = '''<html><head><title>QA Lifecycle Packaging</title><script type="application/ld+json">{"@type":"Organization","name":"QA Lifecycle Packaging","address":{"addressLocality":"Lahore"}}</script></head><body>SIMULATED QA ONLY. QA Lifecycle Packaging manufactures corrugated carton boxes in Lahore Pakistan. <a href="mailto:stock@fixture.invalid">Contact</a></body></html>'''
TEXT = 'QA Lifecycle Packaging manufactures corrugated carton boxes in Lahore Pakistan. stock@fixture.invalid. SIMULATED independent directory fixture; not real commercial verification.'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8026)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.name.startswith('.qa-supplier-final') or not (directory / 'trade.db').is_file():
        raise SystemExit('Only a newly initialized .qa-supplier-final database is allowed')
    sys.path.insert(0, str(ROOT / 'backend'))
    os.environ.update(TRADE_DATA_DIR=str(directory), DISCOVERY_SCHEDULE_SECONDS='0',
        DISCOVERY_SEARCH_PROVIDER='seeds', DISCOVERY_SEED_URLS='https://fixture.invalid/',
        DISCOVERY_ALLOWED_DOMAINS='fixture.invalid', STOCK_EMAIL_MODE='mock',
        STOCK_INBOUND_AUTHORIZED='false', STOCK_LIVE_SEND_AUTHORIZATION='',
        DISCOVERY_ADMIN_ORIGINS='http://localhost:3026,http://127.0.0.1:3026')
    import dotenv
    dotenv.load_dotenv = lambda *a, **k: False
    from agents.supplier_discovery import storage as discovery, providers, workflow
    from agents.supplier_qualification import storage as qualification, research, gemini
    from agents.supplier_catalog_intake import storage as catalog
    from agents.supplier_stock_monitor import storage as stock
    from agents.supplier_qualification.models import Evidence
    schema = (ROOT / 'frontend/lib/trade/db.ts').read_text(encoding='utf-8').split('const SCHEMA = `')[1].split('`;')[0]
    with sqlite3.connect(directory / 'trade.db') as conn:
        conn.executescript(schema)
    discovery.migrate(); qualification.migrate(); catalog.migrate(); stock.migrate()
    with discovery.connection() as conn:
        conn.execute('UPDATE discovery_schedule SET enabled=0')
        conn.execute('UPDATE qualification_settings SET auto_enabled=0')
    providers.dotenv_values = lambda *a, **k: {}
    providers.credential = lambda: ''
    gemini.settings = lambda: {'GEMINI_API_KEY_1': 'QA-MOCK-NOT-A-KEY', 'GEMINI_MODEL': 'gemini-3.5-flash-lite', 'QUALIFICATION_ADDITIONAL_AI_ENABLED': 'false'}
    async def page(url, allowed, robots):
        if url != 'https://fixture.invalid/':
            raise AssertionError('Only the explicit mock page is permitted')
        return HTML, url
    workflow.permitted_page = page
    async def evidence(*a, **k):
        return [Evidence(id='qa-independent', url='https://directory.fixture.invalid/company', observed_at=discovery.now(), kind='independent', text=TEXT,
                         fields={'company': 'QA Lifecycle Packaging', 'city': 'Lahore'})], []
    research.research = evidence
    class MockModels:
        def list(self):
            return [SimpleNamespace(name='models/gemini-3.5-flash-lite', supported_actions=['generateContent'])]
        def generate_content(self, **kwargs):
            with (directory / 'mock-provider-events.jsonl').open('a') as log:
                log.write(json.dumps({'provider':'Gemini SDK MOCK', 'model':kwargs['model'], 'live_requests':0})+'\n')
            return SimpleNamespace(text=json.dumps({'facts':[{'kind':'claim','category':'identity','value':'QA Lifecycle Packaging','evidence_id':'qa-independent','quote':TEXT}]}),
                usage_metadata=SimpleNamespace(prompt_token_count=100,candidates_token_count=40,thoughts_token_count=0))
    class MockClient:
        def __init__(self, **kwargs): self.models = MockModels()
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def close(self): pass
    from google import genai
    genai.Client = MockClient
    # A hard guard makes accidental outbound HTTP fail before network access.
    import httpx
    original_async, original_sync = httpx.AsyncClient.send, httpx.Client.send
    def guard(request):
        if request.url.host not in ('127.0.0.1', 'localhost', 'testserver'):
            with (directory / 'blocked-network.jsonl').open('a') as log:
                log.write(json.dumps({'host':request.url.host})+'\n')
            raise AssertionError('Offline QA forbids all external HTTP')
    async def async_send(client, request, **kwargs):
        guard(request)
        return await original_async(client, request, **kwargs)
    def sync_send(client, request, **kwargs):
        guard(request)
        return original_sync(client, request, **kwargs)
    httpx.AsyncClient.send, httpx.Client.send = async_send, sync_send
    from main import app
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)


if __name__ == '__main__': main()
