"""Two explicitly authorized extraction requests, using saved public evidence only."""
import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.name.startswith('.qa-'):
        raise SystemExit('A disposable .qa- database is required')
    directory.mkdir(parents=True, exist_ok=True)
    os.environ['TRADE_DATA_DIR'] = str(directory)
    with sqlite3.connect(directory / 'trade.db') as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS discovery_leads(id INTEGER PRIMARY KEY)')
    from agents.supplier_qualification import gemini, storage
    from agents.supplier_qualification.models import Evidence, Extraction
    from agents.supplier_discovery.storage import connection
    storage.migrate()
    # Pin the previously selected model and keep additional analysis disabled.
    original_settings = gemini.settings
    gemini.settings = lambda: {**original_settings(), 'GEMINI_MODEL': 'models/gemini-3.5-flash-lite',
                              'QUALIFICATION_ADDITIONAL_AI_ENABLED': 'false'}
    root = Path(__file__).resolve().parents[2]
    saved = json.loads((root / 'deliverables/agent2-real-e2e.json').read_text(encoding='utf-8'))
    supplier = saved['evidence']['supplier'][0]
    sentence = re.search(r'Corruboard Industries is listed.*?Pakistan\.', supplier['text']).group(0)
    market = next(item for item in saved['evidence']['market'] if 'packagingbox.pk' in item['url'])
    price = re.search(r'₨\s*110\s*–\s*₨\s*1,470', market['text'])
    start = market['text'].rfind('Standard Ecommerce Box', 0, price.start())
    market_text = market['text'][start:price.end()]
    sources = {
        'supplier': Evidence(id='supplier-source', url=supplier['url'], kind=supplier['kind'],
                             observed_at=supplier['observed_at'], text=sentence),
        'market': Evidence(id='market-source', url=market['url'], kind=market['kind'],
                           observed_at=market['observed_at'], text=market_text),
    }
    state_path = directory / 'flat-extraction-live.json'
    report = json.loads(state_path.read_text()) if state_path.exists() else {'results': {}, 'search_requests': 0, 'other_key_requests': 0}
    for offset, workload in enumerate(('supplier', 'market'), start=2001):
        if workload in report['results']:
            continue
        report['results'][workload] = {'status': 'Reserved', 'key_name': gemini.key_name(workload)}
        state_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
        reason = ('Extract only the company name and city from this source.' if workload == 'supplier' else
                  'Extract exactly one product description and the published price range. Every unknown field must be an empty string.')
        result = gemini.analyze(offset, [sources[workload]], workload, reason)
        validated = False
        if result['status'] == 'Available':
            payload = Extraction.model_validate(result['analysis'])
            gemini.validate_evidence(payload, [sources[workload]])
            validated = bool(payload.claims) if workload == 'supplier' else bool(payload.product_matches and payload.market_summary)
        report['results'][workload] = {**result, 'pydantic_and_evidence_validated': validated,
                                       'source': sources[workload].model_dump()}
        state_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        with connection() as conn:
            if gemini.quota_reason(conn):
                break
    with connection() as conn:
        report['usage'] = [dict(row) for row in conn.execute('''SELECT key_name,workload,model,purpose,status,
            request_sent,input_tokens,output_tokens,estimated_cost_usd,error,error_code FROM qualification_ai_usage ORDER BY id''')]
    import importlib.metadata
    report.update(sdk_version=importlib.metadata.version('google-genai'), api_version=gemini.api_version(),
                  wire_schema_revision=gemini.WIRE_SCHEMA_REVISION)
    state_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    (root / 'deliverables/agent2-flat-extraction-live.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(report, indent=2, ensure_ascii=True))


if __name__ == '__main__':
    main()
