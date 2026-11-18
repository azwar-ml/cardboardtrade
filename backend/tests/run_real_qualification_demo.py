"""Controlled real evidence demonstration. Explicit stages retain all request allowances."""
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / '.env')
from agents.supplier_discovery import providers
from agents.supplier_discovery.storage import connection, now
from agents.supplier_qualification import storage, workflow, gemini, research
from agents.supplier_qualification.models import Evidence, CompareRequest

PATH = Path(__file__).resolve().parents[2] / 'deliverables/agent2-real-e2e.json'
SCOPE = 'controlled-real-e2e-2026-11-17'
PRODUCT = {'packaging_type': 'corrugated carton', 'dimensions_mm': '304.8 x 228.6 x 152.4',
           'material': 'kraft', 'flute': 'B', 'ply': '3', 'printing': 'none', 'finishing': 'none'}


def save(data):
    PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['search', 'crawl', 'evaluate', 'report'])
    args = parser.parse_args()
    storage.migrate()
    data = json.loads(PATH.read_text(encoding='utf-8')) if PATH.exists() else {
        'started_at': now(), 'supplier_id': 1, 'supplier': 'Corruboard Industries',
        'search_usage_before': providers.usage_status(), 'searches': {}, 'evidence': {}, 'crawl_attempts': [],
        'product': PRODUCT, 'quantity': 1000, 'gemini_allowances': {}, 'jobs': {}}
    if args.stage == 'search':
        queries = {
            'supplier': '"Corruboard Industries" Lahore company address registration -site:cbi.com.pk',
            'market': 'corrugated carton 12x9x6 inch 3 ply price Pakistan Alibaba Made-in-China',
        }
        for kind, query in queries.items():
            if kind in data['searches']:
                continue
            # Reserve task allowance before invoking the existing shared-budget client.
            data['searches'][kind] = {'status': 'Reserved', 'query': query, 'at': now()}
            save(data)
            try:
                actual, results = await providers.duckduckgo_search({'keywords': query})
                data['searches'][kind].update(status='Completed', actual_query=actual, results=results)
            except Exception as exc:
                data['searches'][kind].update(status='Unavailable', error=gemini.safe_error(exc))
            data['search_usage_after'] = providers.usage_status()
            save(data)
        print(json.dumps({'searches': data['searches'], 'shared_usage': providers.usage_status()}, indent=2))
    elif args.stage == 'crawl':
        # Chosen source URLs are recorded after inspecting the two real result sets.
        for kind, urls in data.get('selected_urls', {}).items():
            if kind in data['evidence']:
                continue
            sources, errors = await research.research({}, 'https://www.cbi.com.pk/' if kind == 'supplier' else '', urls, False)
            data['evidence'][kind] = [source.model_dump() for source in sources]
            data['crawl_attempts'].append({'kind': kind, 'urls': urls, 'at': now(), 'errors': errors})
            save(data)
        print(json.dumps({'pages': {k: [{'url': s['url'], 'kind': s['kind'], 'excerpt': s['text'][:1000]} for s in v] for k,v in data['evidence'].items()}, 'attempts': data['crawl_attempts']}, indent=2))
    elif args.stage == 'evaluate':
        for kind in ('supplier', 'market'):
            if kind in data['jobs']:
                continue
            # Separate jobs and an explicit allowlist ensure at most one request per working key.
            payload = {'ai': True, 'ai_workloads': [kind], 'research': False, 'search': False,
                       'source_urls': [], 'demonstration': SCOPE, 'query': data['searches'].get(kind, {}).get('query', '')}
            if kind == 'market':
                payload['comparison'] = {'specification': PRODUCT, 'quantity': 1000, 'currency': 'PKR', 'channel': 'wholesale', 'price_kind': 'advertised'}
            job_id, _ = workflow.create_job('verification' if kind == 'supplier' else 'market', payload,
                                           'controlled-real-demonstration', data['supplier_id'] if kind == 'supplier' else None)
            data['jobs'][kind] = job_id
            data['gemini_allowances'][kind] = 'Reserved'
            save(data)
            with connection() as conn:
                row = conn.execute('SELECT * FROM qualification_jobs WHERE id=?', (job_id,)).fetchone()
                job = storage.decoded(row)
            collected = await workflow.collect({'job': job})
            extra = []
            for group in (kind, 'official' if kind == 'supplier' else 'market-extra'):
                for item in data['evidence'].get(group, []):
                    item = {**item, 'id': group + '-' + item['id']}
                    for price in item.get('fields', {}).get('price_references', []):
                        price['evidence_id'] = item['id']
                    extra.append(Evidence.model_validate(item))
            for i, result in enumerate(data['searches'].get(kind, {}).get('results', [])[:6]):
                extra.append(Evidence(id=kind+'-search-'+str(i), url=result['url'], kind='search',
                    observed_at=data['searches'][kind]['at'], text=(result['title']+'\n'+result['snippet'])[:16000]))
            evidence = collected['evidence'] + extra
            with connection() as conn:
                conn.execute("UPDATE qualification_jobs SET status='Running' WHERE id=?", (job_id,))
                for source in extra:
                    conn.execute('INSERT INTO qualification_evidence(job_id,payload) VALUES(?,?)', (job_id, source.model_dump_json()))
            evaluated = await workflow.evaluate({'job': job, 'lead': collected['lead'], 'evidence': evidence,
                                                 'errors': [error for a in data['crawl_attempts'] for error in a['errors']]})
            await workflow.persist({'job': job, 'report': evaluated['report']})
            data['gemini_allowances'][kind] = 'Consumed or cached; no automatic repetition'
            save(data)
        print(json.dumps({'jobs': data['jobs'], 'gemini_allowances': data['gemini_allowances']}, indent=2))
    if args.stage in ('evaluate', 'report'):
        with connection() as conn:
            data['reports'] = {kind: storage.decoded(conn.execute('SELECT * FROM qualification_jobs WHERE id=?', (job_id,)).fetchone()) for kind,job_id in data['jobs'].items()}
            data['ai_usage'] = [dict(r) for r in conn.execute('SELECT * FROM qualification_ai_usage WHERE job_id IN (SELECT id FROM qualification_jobs WHERE actor=?)', ('controlled-real-demonstration',))]
        data['search_usage_after'] = providers.usage_status()
        save(data)
        print(json.dumps({'statuses': {k: v['status'] for k,v in data['reports'].items()}, 'ai_usage': data['ai_usage']}, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
