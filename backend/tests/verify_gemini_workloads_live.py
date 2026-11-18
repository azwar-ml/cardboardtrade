"""Explicit Gemini-only live check against a disposable database. No supplier jobs."""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--free-tier-confirmed', nargs='*', choices=['GEMINI_API_KEY_2', 'GEMINI_API_KEY_3'], default=[])
    args = parser.parse_args()
    directory = args.data_dir.resolve()
    if not directory.name.startswith('.qa-'):
        raise SystemExit('A disposable .qa- directory is required')
    directory.mkdir(parents=True, exist_ok=True)
    os.environ['TRADE_DATA_DIR'] = str(directory)
    with sqlite3.connect(directory / 'trade.db') as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS discovery_leads(id INTEGER PRIMARY KEY)')
    from agents.supplier_qualification import gemini, storage
    from agents.supplier_discovery.storage import connection
    storage.migrate()
    results = []
    for workload in gemini.WORKLOADS:
        name = gemini.key_name(workload)
        if workload != 'supplier' and name not in args.free_tier_confirmed:
            results.append({'key_name': name, 'status': 'NOT VERIFIED', 'generation_requests': 0,
                            'reason': 'Project free-tier eligibility has not been confirmed'})
            continue
        result = gemini.probe(workload)
        results.append(result)
        if result['status'] != 'Passed':
            break
    tested = {result['key_name'] for result in results}
    for workload in gemini.WORKLOADS:
        name = gemini.key_name(workload)
        if name not in tested:
            results.append({'key_name': name, 'status': 'NOT VERIFIED', 'generation_requests': 0,
                            'reason': 'A preceding test failed; subsequent live generation stopped'})
    with connection() as conn:
        usage = [dict(row) for row in conn.execute('''SELECT key_name,model,status,request_sent,input_tokens,
            output_tokens,estimated_cost_usd,error,error_code FROM qualification_ai_usage WHERE purpose='workload-probe' ORDER BY id''')]
    import importlib.metadata
    report = {'sdk_version': importlib.metadata.version('google-genai'), 'api_version': gemini.api_version(),
              'results': results, 'usage': usage, 'serpapi_searches': 0, 'keys_4_to_15_requests': 0,
              'paid_billing_activated': False, 'pricing_source': gemini.PRICING_SOURCE,
              'project_free_tier_confirmed_by_user': args.free_tier_confirmed,
              'cost_basis': 'Published paid-tier estimate. Free-tier billing depends on the confirmed project tier.'}
    path = Path(__file__).resolve().parents[2] / 'deliverables/agent2-gemini-three-key-live.json'
    path.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
