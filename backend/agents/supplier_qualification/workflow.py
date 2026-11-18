import asyncio
import hashlib
import json
import re
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from agents.supplier_discovery.storage import connection, now, domain, sync_submissions
from .storage import decoded
from .models import Evidence, CompareRequest
from .verification import verify
from .comparison import compare
from . import gemini, research


class State(TypedDict, total=False):
    job: dict
    lead: dict
    evidence: list
    errors: list
    report: dict


def lead_snapshot(lead_id):
    with connection() as conn:
        row = conn.execute('SELECT * FROM discovery_leads WHERE id=?', (lead_id,)).fetchone()
        if not row:
            raise LookupError('Supplier not found')
        lead = dict(row)
        lead['products'] = json.loads(lead['products'])
        sources = [dict(r) for r in conn.execute('SELECT * FROM discovery_sources WHERE lead_id=? ORDER BY id', (lead_id,))]
    return lead, sources


def create_job(kind, payload, actor, lead_id=None):
    snapshot = lead_snapshot(lead_id) if lead_id else payload
    revision = 'rules-v1'
    if payload.get('ai', True):
        config = gemini.settings()
        revision = {'rules': 'rules-v1', 'ai': gemini.WIRE_SCHEMA_REVISION,
                    'model': str(config.get('GEMINI_MODEL') or ''),
                    'api_version': str(config.get('GEMINI_API_VERSION') or 'v1beta'),
                    'configured_workloads': [bool(gemini.credential(name)) for name in gemini.WORKLOADS],
                    'quota_reviewed_at': str(config.get('GEMINI_QUOTA_REVIEWED_AT') or '')}
    digest = hashlib.sha256(json.dumps([snapshot, payload, revision], sort_keys=True).encode()).hexdigest()
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute("SELECT * FROM qualification_jobs WHERE fingerprint=? AND status IN ('Queued','Running','Completed') ORDER BY id DESC LIMIT 1", (digest,)).fetchone()
        if existing:
            return existing['id'], True
        job_id = conn.execute('''INSERT INTO qualification_jobs(lead_id,kind,status,actor,input,fingerprint,created_at)
          VALUES(?,?,'Queued',?,?,?,?)''', (lead_id, kind, actor, json.dumps(payload), digest, now())).lastrowid
    return job_id, False


async def collect(state):
    job, evidence = state['job'], []
    lead = {}
    if job['lead_id']:
        lead, sources = lead_snapshot(job['lead_id'])
        for source in sources:
            raw = json.loads(source['evidence'])
            source_domain = domain(source['url']) if source['url'] else ''
            kind = 'submission' if source['source_type'] == 'Website Submission' else 'supplier' if source_domain == domain(lead['website']) else 'search'
            evidence.append(Evidence(id='saved-' + str(source['id']), url=source['url'], kind=kind,
                observed_at=source['accessed_at'], text=str(raw.get('text_excerpt') or json.dumps(raw, ensure_ascii=False))[:16000], fields=raw.get('fields', {})))
    payload = job['input']
    # Automatic evaluations use saved evidence and never initiate searches or generation.
    if payload.get('research'):
        criteria = {'keywords': lead.get('company', '') + ' company registration certification' if lead else payload.get('query', ''),
                    'company': lead.get('company', '')}
        urls = payload.get('source_urls') or ([lead['website']] if lead.get('website') else [])
        extra, errors = await research.research(criteria, lead.get('website', ''), urls, payload.get('search', False))
        evidence.extend(extra)
    else:
        errors = []
    with connection() as conn:
        conn.execute('DELETE FROM qualification_evidence WHERE job_id=?', (job['id'],))
        for source in evidence:
            conn.execute('INSERT INTO qualification_evidence(job_id,payload) VALUES(?,?)', (job['id'], source.model_dump_json()))
    return {'lead': lead, 'evidence': evidence, 'errors': errors}


async def evaluate(state):
    job, evidence = state['job'], state['evidence']
    report = verify(state['lead'], evidence) if state['lead'] else {'summary': 'Market source research completed', 'findings': [], 'risk_flags': []}
    workload = 'supplier' if state['lead'] else 'market'
    enabled = job['input'].get('ai', True)
    allowed_workloads = job['input'].get('ai_workloads') or ['supplier', 'market']
    enabled = enabled and workload in allowed_workloads
    ai = await asyncio.to_thread(gemini.analyze, job['id'], evidence, workload) if enabled else {'status': 'Unavailable', 'reason': 'Rule-based evaluation requested', 'analysis': None}
    analyses = {workload: ai}
    price_evidence = any(re.search(r'\b(?:PKR|USD|EUR|GBP)\s*\d|\d\s*(?:PKR|USD|EUR|GBP)\b', item.text, re.I)
                         or item.fields.get('price_references') for item in evidence)
    if enabled and 'market' in allowed_workloads and workload == 'supplier' and (price_evidence or job['input'].get('comparison')):
        analyses['market'] = await asyncio.to_thread(gemini.analyze, job['id'], evidence, 'market')
    conflicting = any(finding['result'] == 'Conflicting' for finding in report['findings'])
    interpreted_conflicts = any((result.get('analysis') or {}).get('contradictions') for result in analyses.values())
    market_analysis = analyses.get('market', {}).get('analysis') or {}
    ambiguous = len(market_analysis.get('product_matches', [])) >= 2 and any(
        not all(price['specification'].values()) for price in market_analysis.get('prices', []))
    if enabled and gemini.additional_enabled() and any(result['status'] == 'Available' for result in analyses.values()) and (conflicting or interpreted_conflicts or ambiguous):
        analyses['additional'] = await asyncio.to_thread(gemini.analyze, job['id'], evidence, 'additional',
                                                       'Review conflicting evidence or incomplete specifications across potential product matches using exact source quotes.')
    # AI annotations never override deterministic findings or insert prices.
    report.update({'ai': ai, 'evidence': [item.model_dump() for item in evidence], 'research_errors': state['errors'],
                   'checked_at': now(), 'admin_approval_required': True})
    report['ai_workloads'] = analyses
    report['provisional_prices'] = (analyses.get('market', {}).get('analysis') or {}).get('prices', [])
    report['market_observations'] = research.price_observations(evidence) if workload == 'market' else []
    with connection() as conn:
        for price in research.extract_prices(evidence):
            serialized = price.model_dump_json()
            conn.execute('INSERT OR IGNORE INTO qualification_prices(job_id,digest,payload) VALUES(?,?,?)',
                         (job['id'], hashlib.sha256(serialized.encode()).hexdigest(), serialized))
        prices = [{'id': r['id'], 'reference': json.loads(r['payload'])} for r in conn.execute('SELECT * FROM qualification_prices')]
    report['market_references'] = [p for p in prices if any(s.url.rstrip('/') == p['reference']['source_url'].rstrip('/') for s in evidence)]
    if job['input'].get('comparison'):
        report['comparison'] = compare(CompareRequest.model_validate(job['input']['comparison']), prices)
    elif not prices:
        report['comparison'] = {'status': 'Insufficient Comparable Data', 'matched': [], 'excluded': [], 'range': None}
    return {'report': report}


async def persist(state):
    with connection() as conn:
        conn.execute("UPDATE qualification_jobs SET status='Completed',report=?,finished_at=? WHERE id=? AND status='Running'",
                     (json.dumps(state['report']), now(), state['job']['id']))
    return {}


def graph():
    workflow = StateGraph(State)
    workflow.add_node('collect', collect)
    workflow.add_node('evaluate', evaluate)
    workflow.add_node('persist', persist)
    workflow.add_edge(START, 'collect')
    workflow.add_edge('collect', 'evaluate')
    workflow.add_edge('evaluate', 'persist')
    workflow.add_edge('persist', END)
    return workflow.compile()


async def run_job(job_id):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM qualification_jobs WHERE id=?', (job_id,)).fetchone()
        if not row or row['status'] != 'Queued':
            return
        conn.execute("UPDATE qualification_jobs SET status='Running' WHERE id=?", (job_id,))
        job = decoded(row)
    try:
        await graph().ainvoke({'job': job})
    except asyncio.CancelledError:
        with connection() as conn:
            conn.execute("UPDATE qualification_jobs SET status='Failed',error='Service interrupted',finished_at=? WHERE id=?", (now(), job_id))
        raise
    except Exception as exc:
        with connection() as conn:
            conn.execute("UPDATE qualification_jobs SET status='Failed',error=?,finished_at=? WHERE id=?", (gemini.safe_error(exc), now(), job_id))


async def queue_tick():
    with connection() as conn:
        config = conn.execute('SELECT * FROM qualification_settings WHERE id=1').fetchone()
        pending = [r[0] for r in conn.execute("SELECT id FROM discovery_leads WHERE status='Pending Review' ORDER BY id LIMIT 500")]
    if config['auto_enabled']:
        count = 0
        for lead_id in pending:
            with connection() as conn:
                if conn.execute("SELECT 1 FROM qualification_jobs WHERE lead_id=? AND status IN ('Queued','Running')", (lead_id,)).fetchone():
                    continue
                current_report = conn.execute('''SELECT 1 FROM qualification_jobs j JOIN discovery_leads l ON l.id=j.lead_id
                    WHERE j.lead_id=? AND j.status='Completed' AND j.created_at>=l.updated_at
                    AND j.created_at>=(SELECT COALESCE(MAX(accessed_at),'') FROM discovery_sources WHERE lead_id=l.id)''', (lead_id,)).fetchone()
                if current_report:
                    continue
            _, reused = create_job('verification', {'ai': False, 'research': False, 'search': False, 'source_urls': []}, 'qualification-queue', lead_id)
            count += int(not reused)
            if count >= config['batch_size']:
                break
    with connection() as conn:
        queued = [r[0] for r in conn.execute("SELECT id FROM qualification_jobs WHERE status='Queued' ORDER BY id LIMIT ?", (config['batch_size'],))]
    for job_id in queued:
        await run_job(job_id)


async def worker():
    while True:
        try:
            await queue_tick()
        except Exception:
            import logging
            logging.getLogger(__name__).error('Qualification queue iteration failed')
        await asyncio.sleep(30)
