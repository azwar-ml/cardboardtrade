"""Explicit one-request Gemini probe and saved-evidence demonstration. Never searches."""
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agents.supplier_discovery.storage import connection, database_path
from agents.supplier_qualification import gemini, storage, workflow


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--lead-id', type=int)
    args = parser.parse_args()
    # Preserve all original tables with a SQLite-consistent backup before additive migration.
    backup = database_path().with_name('trade.db.pre-qualification.bak')
    if not backup.exists():
        import sqlite3
        with connection() as source, sqlite3.connect(backup) as target:
            source.backup(target)
    storage.migrate()
    result = {'search_requests': 0, 'other_keys_used': 0}
    if args.probe:
        result['gemini_probe'] = gemini.probe()
    with connection() as conn:
        result['api_usage'] = {
            'generation_attempts': conn.execute("SELECT count(*) FROM qualification_ai_usage WHERE purpose='live-probe-result'").fetchone()[0],
            'reported_input_tokens': conn.execute('SELECT COALESCE(SUM(input_tokens),0) FROM qualification_ai_usage').fetchone()[0],
            'reported_output_tokens': conn.execute('SELECT COALESCE(SUM(output_tokens),0) FROM qualification_ai_usage').fetchone()[0],
            'cost_status': 'Unknown when the provider omits usage or model-specific rates are unconfigured',
        }
    with connection() as conn:
        lead = conn.execute("SELECT id FROM discovery_leads WHERE status='Pending Review' AND website!='' ORDER BY id LIMIT 1").fetchone()
    lead_id = args.lead_id or (lead[0] if lead else None)
    if lead_id:
        # A failed probe permits demonstrating fallback without another generation request.
        probe_failed = result.get('gemini_probe', {}).get('status') == 'Unavailable'
        job_id, reused = workflow.create_job('verification', {'ai': probe_failed, 'research': False, 'search': False, 'source_urls': []}, 'saved-evidence-demonstration', lead_id)
        asyncio.run(workflow.run_job(job_id))
        with connection() as conn:
            result['evaluation'] = storage.decoded(conn.execute('SELECT * FROM qualification_jobs WHERE id=?', (job_id,)).fetchone())
    else:
        result['evaluation'] = {'status': 'NOT VERIFIED', 'reason': 'No existing supplier record available'}
    target = Path(__file__).resolve().parents[2] / 'deliverables/agent2-live-results.json'
    target.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'probe': result.get('gemini_probe'), 'evaluation_id': result['evaluation'].get('id'),
                      'evaluation_status': result['evaluation'].get('status'), 'search_requests': 0, 'other_keys_used': 0}, indent=2))


if __name__ == '__main__':
    main()
