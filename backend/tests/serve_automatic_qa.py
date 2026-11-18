"""Explicit QA server: mocked DuckDuckGo HTTP responses, REAL guarded public-page crawling.

Never used by production startup. Requires an already-created disposable .qa- directory.
"""
import argparse
import os
import sqlite3
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.name.startswith('.qa-') or not (directory / 'trade.db').is_file():
        raise SystemExit('Refusing non-QA or uninitialised data. Use prepare-disposable-qa.mjs with a new .qa- directory.')
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'backend'))
    schema = (root / 'frontend/lib/trade/db.ts').read_text(encoding='utf-8').split('const SCHEMA = `')[1].split('`;')[0]
    with sqlite3.connect(directory / 'trade.db') as conn:
        conn.executescript(schema)
    os.environ.update(TRADE_DATA_DIR=str(directory), DISCOVERY_SEARCH_PROVIDER='duckduckgo', DISCOVERY_SOURCE_POLICY='public',
                      SERPAPI_API_KEY='QA-MOCK-TOKEN-NOT-A-REAL-KEY', DISCOVERY_SCHEDULE_SECONDS='0', DISCOVERY_TEST_MODE='1')
    import httpx
    from agents.supplier_discovery import providers
    real_client = httpx.AsyncClient

    def mock_provider(request):
        if request.url.host != 'serpapi.com':
            raise AssertionError('The mock transport is only for DuckDuckGo via SerpApi')
        if request.url.path == '/account.json':
            return httpx.Response(200, json={'this_month_usage': 0, 'plan_searches_left': 250, 'total_searches_left': 250, 'searches_per_month': 250, 'account_status': 'Active', 'plan_renewal_date': '2026-12-17'})
        return httpx.Response(200, json={'organic_results': [
            {'link': 'https://www.cbi.com.pk/', 'title': 'Corruboard Industries',
             'snippet': 'Pakistani corrugated packaging manufacturer; mocked search reference to real website'},
            {'link': 'http://127.0.0.1/private', 'title': 'Unsafe QA result',
             'snippet': 'Packaging manufacturer; unsafe URL must be rejected before fetching'}]})

    providers.httpx.AsyncClient = lambda **kwargs: real_client(transport=httpx.MockTransport(mock_provider), **kwargs)
    from main import app
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)


if __name__ == '__main__':
    main()
