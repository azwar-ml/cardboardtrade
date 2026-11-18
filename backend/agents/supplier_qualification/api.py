import hashlib
import json
import sqlite3
from typing import Optional, Literal
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import Field
from agents.supplier_discovery.api import admin
from agents.supplier_discovery.storage import connection, now, sync_submissions
from .models import StrictModel, CompareRequest, PriceReference, Evidence
from .storage import decoded
from .workflow import create_job, run_job
from .comparison import compare

router = APIRouter(prefix='/api/v1/qualification', dependencies=[Depends(admin)])


class Evaluation(StrictModel):
    research: bool = False
    search: bool = False
    ai: bool = True
    source_urls: list[str] = Field(default_factory=list, max_length=3)
    ai_workloads: Optional[list[Literal['supplier', 'market']]] = Field(default=None, min_length=1, max_length=2)


class MarketResearch(Evaluation):
    query: str = Field(min_length=3, max_length=300)
    comparison: Optional[CompareRequest] = None


def enqueue(kind, payload, background, actor, lead_id=None):
    if payload.search and not payload.research:
        raise HTTPException(422, 'Enable research to run a search')
    try:
        job_id, reused = create_job(kind, payload.model_dump(mode='json'), actor, lead_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'An evaluation for this supplier or market is active')
    if not reused:
        background.add_task(run_job, job_id)
    return {'id': job_id, 'reused': reused}


@router.get('/summary')
def summary():
    from .gemini import configuration, quota_reason
    sync_submissions()
    with connection() as conn:
        counts = dict(conn.execute('SELECT status,count(*) FROM qualification_jobs GROUP BY status'))
        usage = [dict(r) for r in conn.execute('SELECT * FROM qualification_ai_usage ORDER BY id DESC LIMIT 100')]
        config = dict(conn.execute('SELECT * FROM qualification_settings WHERE id=1').fetchone())
        pending = conn.execute("SELECT count(*) FROM discovery_leads WHERE status='Pending Review'").fetchone()[0]
        benchmarks = conn.execute('SELECT count(*) FROM qualification_prices').fetchone()[0]
        ai_blocked_reason = quota_reason(conn)
    return {'pending': pending, 'completed': counts.get('Completed', 0), 'active': counts.get('Running', 0) + counts.get('Queued', 0),
            'benchmarks': benchmarks, 'ai_usage': usage, 'ai_configuration': configuration(),
            'ai_blocked_reason': ai_blocked_reason, 'automation': config, 'mode': 'live'}


@router.get('/suppliers')
def suppliers(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    sync_submissions()
    with connection() as conn:
        rows = conn.execute('''SELECT l.id,l.company,l.city,l.status,j.id evaluation_id,j.status evaluation_status,j.report,j.review_status
          FROM discovery_leads l LEFT JOIN qualification_jobs j ON j.id=(SELECT MAX(id) FROM qualification_jobs WHERE lead_id=l.id)
          WHERE l.status IN ('Pending Review','Reviewed') ORDER BY l.id DESC LIMIT ? OFFSET ?''', (page_size, (page-1)*page_size))
        return {'items': [decoded(r) for r in rows]}


@router.post('/suppliers/{lead_id}/evaluate', status_code=202)
def evaluate(lead_id: int, payload: Evaluation, background: BackgroundTasks, user=Depends(admin)):
    return enqueue('verification', payload, background, user['email'], lead_id)


@router.get('/jobs')
def jobs():
    with connection() as conn:
        return {'items': [decoded(r) for r in conn.execute('SELECT * FROM qualification_jobs ORDER BY id DESC LIMIT 100')]}


@router.get('/jobs/{job_id}')
def job(job_id: int):
    with connection() as conn:
        row = conn.execute('SELECT * FROM qualification_jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Evaluation not found')
        return decoded(row)


class Review(StrictModel):
    status: Literal['Reviewed', 'Documents Requested', 'Rejected', 'Pending Admin Review']
    note: str = Field(min_length=1, max_length=2000)


@router.post('/jobs/{job_id}/review')
def review(job_id: int, payload: Review, user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        previous = conn.execute('SELECT lead_id,review_status,review_note FROM qualification_jobs WHERE id=?', (job_id,)).fetchone()
        changed = conn.execute("UPDATE qualification_jobs SET review_status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='Completed'",
                              (payload.status, payload.note, user['email'], now(), job_id))
        if not changed.rowcount:
            raise HTTPException(409, 'A completed evaluation is required')
        conn.execute('INSERT INTO discovery_activity(lead_id,actor,action,detail,at) VALUES(?,?,?,?,?)',
                     (previous['lead_id'], user['email'], 'Qualification review',
                      json.dumps({'qualification_job_id': job_id, 'before': previous['review_status'],
                                  'previous_note': previous['review_note'], 'after': payload.status, 'note': payload.note}), now()))
    return {'status': payload.status}


class Automation(StrictModel):
    enabled: bool
    batch_size: int = Field(2, ge=1, le=5)


@router.post('/automation')
def automation(payload: Automation):
    with connection() as conn:
        conn.execute('UPDATE qualification_settings SET auto_enabled=?,batch_size=? WHERE id=1', (payload.enabled, payload.batch_size))
    return {'enabled': payload.enabled, 'batch_size': payload.batch_size, 'source': 'saved evidence', 'search_requests': 0}


@router.post('/market/research', status_code=202)
def market_research(payload: MarketResearch, background: BackgroundTasks, user=Depends(admin)):
    return enqueue('market', payload, background, user['email'])


@router.get('/market/prices')
def prices():
    with connection() as conn:
        return {'items': [{'id': r['id'], 'job_id': r['job_id'], 'reference': json.loads(r['payload'])} for r in conn.execute('SELECT * FROM qualification_prices ORDER BY id DESC')]}


class PriceEntry(StrictModel):
    job_id: int
    reference: PriceReference


@router.post('/market/prices', status_code=201)
def add_price(payload: PriceEntry):
    reference = payload.reference
    with connection() as conn:
        sources = [Evidence.model_validate_json(r[0]) for r in conn.execute('SELECT payload FROM qualification_evidence WHERE job_id=?', (payload.job_id,))]
        source = next((s for s in sources if s.id == reference.evidence_id), None)
        if source is None or source.kind in ('search', 'submission') or str(reference.source_url).rstrip('/') != source.url.rstrip('/') or reference.source_quote not in source.text or reference.observed_at != source.observed_at:
            raise HTTPException(422, 'Price requires an exact quotation and observation date from a retrieved page in this job')
        from .research import validate_price_quote
        try:
            validate_price_quote(reference)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        serialized = reference.model_dump_json()
        conn.execute('INSERT OR IGNORE INTO qualification_prices(job_id,digest,payload) VALUES(?,?,?)',
                     (payload.job_id, hashlib.sha256(serialized.encode()).hexdigest(), serialized))
    return {'status': 'Saved', 'source': 'Admin-confirmed source extraction'}


@router.post('/market/compare')
def market_compare(payload: CompareRequest):
    with connection() as conn:
        records = [{'id': r['id'], 'reference': json.loads(r['payload'])} for r in conn.execute('SELECT * FROM qualification_prices')]
    return compare(payload, records)
