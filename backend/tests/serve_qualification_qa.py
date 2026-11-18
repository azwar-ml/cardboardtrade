"""Disposable browser-test server. All research and AI responses are fixtures."""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8012)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.name.startswith('.qa-') or not (directory / 'trade.db').is_file():
        raise SystemExit('Use an initialized disposable .qa- database')
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'backend'))
    os.environ.update(TRADE_DATA_DIR=str(directory), DISCOVERY_SCHEDULE_SECONDS='0', SERPAPI_API_KEY='', DISCOVERY_SEED_URLS='')
    schema = (root / 'frontend/lib/trade/db.ts').read_text(encoding='utf-8').split('const SCHEMA = `')[1].split('`;')[0]
    with sqlite3.connect(directory / 'trade.db') as conn:
        conn.executescript(schema)
    from agents.supplier_discovery import storage as discovery, providers
    from agents.supplier_qualification import gemini, research
    from agents.supplier_qualification.models import Evidence
    discovery.migrate()
    providers.credential = lambda: ''
    gemini.settings = lambda: {}
    spec = {'packaging_type': 'carton', 'dimensions_mm': '100 x 200 x 300', 'material': 'kraft', 'flute': 'B', 'ply': '3', 'printing': 'none', 'finishing': 'none'}
    stamp = discovery.now()
    company = {'company': 'QA Fixture Packaging', 'website': 'https://supplier.invalid/', 'city': 'Lahore', 'country': 'Pakistan',
               'products': ['carton'], 'email': 'info@supplier.invalid', 'phone': ''}
    with discovery.connection() as conn:
        discovery.save_lead(conn, company, 'qa:qualification', 'Automated Discovery',
                            {'fields': company, 'text_excerpt': 'QA Fixture Packaging manufactures carton packaging in Lahore Pakistan. info@supplier.invalid'}, url=company['website'])

    async def mock_research(*args, **kwargs):
        sources = []
        for i, amount in enumerate(('100', '120')):
            url = f'https://market-{i}.invalid/price'
            text = f'QA Fixture Packaging. Kraft carton 100 x 200 x 300 mm, B flute, 3 ply, no printing, no finishing. PKR {amount} per 10 pieces. MOQ 100.'
            reference = {'description': 'QA fixture kraft carton', 'specification': spec, 'amount': amount, 'currency': 'PKR',
                         'pieces_per_unit': 10, 'moq': 100, 'tier_min': 100, 'channel': 'wholesale', 'price_kind': 'advertised',
                         'source_url': url, 'observed_at': stamp, 'source_quote': text, 'evidence_id': f'qa-price-{i}'}
            sources.append(Evidence(id=f'qa-price-{i}', url=url, observed_at=stamp, text=text, kind='independent', fields={'price_references': [reference]}))
        return sources, []

    research.research = mock_research
    import httpx
    async def forbidden(*args, **kwargs):
        raise RuntimeError('Live provider requests are disabled in qualification QA')
    providers.safe_get = forbidden
    from main import app
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)


if __name__ == '__main__':
    main()
