import json
import sqlite3
from typing import Optional, Literal
from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from .storage import connection, now, sync_submissions, matches, domain
from .workflow import configuration, create_job, run_job, cancel_job
from .safety import resolve_public
from .providers import verify_account, fingerprint, SearchError, usage_status
from .scheduling import schedule_status, save_schedule, research_mode, AUTOMATION_INTERVAL
from .workflow import record_provider_check


def admin(request: Request, cp_session: Optional[str] = Cookie(default=None)):
    if not cp_session:
        raise HTTPException(401, 'Sign in required')
    with connection() as conn:
        user = conn.execute('''SELECT u.id,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token=? AND s.expires_at>? AND u.active=1''', (cp_session, now())).fetchone()
    if not user:
        raise HTTPException(401, 'Session expired')
    if user['role'] != 'admin':
        raise HTTPException(403, 'Admin access required')
    if request.method != 'GET':
        # SameSite cookies plus Origin validation for direct browser requests.
        origin = request.headers.get('origin')
        allowed = {request.url.scheme + '://' + request.url.netloc}
        import os
        allowed.update(os.getenv('DISCOVERY_ADMIN_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000').split(','))
        if origin and origin not in allowed:
            raise HTTPException(403, 'Untrusted origin')
    return dict(user)


router = APIRouter(prefix='/api/v1/discovery', dependencies=[Depends(admin)])


def decoded(row):
    result = dict(row)
    for field in ('products', 'duplicate_matches', 'filters', 'evidence'):
        if field in result:
            result[field] = json.loads(result[field])
    return result


@router.get('/summary')
def summary():
    sync_submissions()
    with connection() as conn:
        total = conn.execute('SELECT count(*) FROM discovery_leads').fetchone()[0]
        website = conn.execute("SELECT count(DISTINCT lead_id) FROM discovery_sources WHERE source_type='Website Submission'").fetchone()[0]
        web = conn.execute("SELECT count(DISTINCT lead_id) FROM discovery_sources WHERE source_type='Automated Discovery'").fetchone()[0]
        pending = conn.execute("SELECT count(*) FROM discovery_leads WHERE status='Pending Review'").fetchone()[0]
        duplicates = conn.execute("SELECT count(*) FROM discovery_activity WHERE action='Duplicate linked'").fetchone()[0]
        jobs = dict(conn.execute('SELECT status,count(*) FROM discovery_jobs GROUP BY status'))
        last = conn.execute('SELECT * FROM discovery_jobs ORDER BY id DESC LIMIT 1').fetchone()
        success = conn.execute("SELECT finished_at FROM discovery_jobs WHERE status='Completed' AND found+duplicates>0 ORDER BY id DESC LIMIT 1").fetchone()
        checked = conn.execute('SELECT * FROM discovery_provider_check WHERE id=1').fetchone()
    provider_check = {k: checked[k] for k in ('status', 'checked_at', 'error', 'result_count')} if checked and checked['fingerprint'] == fingerprint() else {'status': 'Not checked', 'checked_at': None, 'error': None}
    schedule = schedule_status()
    usage = usage_status()
    active = bool(jobs.get('Running', 0) + jobs.get('Queued', 0))
    agent_status = 'Running' if active else 'Paused' if not schedule['enabled'] or schedule['blocked_reason'] or usage['paused_reason'] else 'Error' if last and last['status'] == 'Failed' else 'Ready'
    return {'total': total, 'web_discoveries': web, 'website_submissions': website, 'pending_review': pending,
            'duplicates': duplicates, 'completed_jobs': jobs.get('Completed', 0), 'failed_jobs': jobs.get('Failed', 0),
            'last_research': success['finished_at'] if success else None, 'active': active, 'agent_status': agent_status,
            'configuration': configuration(), 'latest_job': decoded(last) if last else None,
            'schedule': schedule, 'provider_check': provider_check,
            'search_usage': usage,
            'mode': 'unverified leads'}


@router.get('/leads')
def leads(q: str = Query('', max_length=200), city: str = Query('', max_length=100), product: str = Query('', max_length=100),
          status: str = Query('', max_length=40), page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)):
    sync_submissions()
    where, args = ['1=1'], []
    for column, value in [('company', q), ('city', city), ('products', product)]:
        if value:
            where.append(f'{column} LIKE ?')
            args.append('%' + value + '%')
    if status:
        where.append('status=?')
        args.append(status)
    clause = ' AND '.join(where)
    with connection() as conn:
        total = conn.execute('SELECT count(*) FROM discovery_leads WHERE ' + clause, args).fetchone()[0]
        items = conn.execute('SELECT * FROM discovery_leads WHERE ' + clause + ' ORDER BY id DESC LIMIT ? OFFSET ?', args + [page_size, (page-1)*page_size]).fetchall()
    return {'items': [decoded(r) for r in items], 'total': total, 'page': page, 'page_size': page_size}


@router.get('/leads/{lead_id}')
def detail(lead_id: int):
    with connection() as conn:
        lead = conn.execute('SELECT * FROM discovery_leads WHERE id=?', (lead_id,)).fetchone()
        if not lead:
            raise HTTPException(404, 'Lead not found')
        result = decoded(lead)
        data = dict(lead)
        data['domain'] = domain(data['website'])
        result['duplicate_matches'] = [m for m in matches(conn, data) if not (m['kind'] == 'lead' and m['id'] == lead_id)]
        result['sources'] = [decoded(r) for r in conn.execute('SELECT * FROM discovery_sources WHERE lead_id=? ORDER BY id DESC', (lead_id,))]
        result['history'] = [dict(r) for r in conn.execute('SELECT * FROM discovery_activity WHERE lead_id=? ORDER BY id DESC', (lead_id,))]
        result['research'] = [dict(r) for r in conn.execute('SELECT * FROM discovery_attempts WHERE lead_id=? ORDER BY id DESC', (lead_id,))]
    return result


class Research(BaseModel):
    product: str = Field('', max_length=100)
    city: str = Field('', max_length=100)
    keywords: str = Field('', max_length=200)
    seed_urls: list[str] = Field(default_factory=list, max_length=20)
    source_permission_confirmed: bool = False
    mode: Optional[Literal['automatic', 'manual', 'seeds']] = None


@router.post('/jobs', status_code=202)
def start(payload: Research, background: BackgroundTasks, user=Depends(admin)):
    config = configuration()
    mode = payload.mode or ('manual' if payload.seed_urls else 'automatic' if config['search_provider'] == 'duckduckgo' else 'seeds')
    if mode == 'automatic':
        if payload.seed_urls:
            raise HTTPException(422, 'Choose automatic search or manual URLs, not both')
        if not config['automatic_ready']:
            raise HTTPException(422, ' '.join(config['setup_errors']) or 'Configure DuckDuckGo via SerpApi for automatic discovery')
        if not any(v.strip() for v in (payload.product, payload.city, payload.keywords)):
            raise HTTPException(422, 'Enter a product, city or keywords for automatic discovery')
    if mode == 'manual' and not payload.seed_urls:
        raise HTTPException(422, 'Manual website research requires a public supplier URL')
    if mode == 'seeds' and not (payload.seed_urls or config['seed_urls']):
        raise HTTPException(422, 'No permitted seed URLs are configured')
    if not (payload.seed_urls or config['seed_urls'] or (config['search_provider'] == 'duckduckgo' and config['search_configured'])):
        raise HTTPException(422, 'Configure permitted seed URLs or DuckDuckGo search credentials before running discovery')
    for url in payload.seed_urls:
        if domain(url) not in config['allowed_domains'] and not payload.source_permission_confirmed:
            raise HTTPException(422, 'Confirm permission to research this public website, or use a configured permitted source')
        try:
            resolve_public(url)
        except (ValueError, OSError) as exc:
            raise HTTPException(422, 'Invalid public source URL: ' + str(exc))
    try:
        job_id = create_job({**payload.model_dump(), 'mode': mode}, user['email'])
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'A discovery job is already active')
    background.add_task(run_job, job_id)
    return {'id': job_id, 'status': 'Queued'}


@router.get('/jobs')
def jobs(page: int = Query(1, ge=1), page_size: int = Query(10, ge=1, le=100)):
    with connection() as conn:
        total = conn.execute('SELECT count(*) FROM discovery_jobs').fetchone()[0]
        rows = conn.execute('SELECT * FROM discovery_jobs ORDER BY id DESC LIMIT ? OFFSET ?', (page_size, (page-1)*page_size))
        return {'items': [decoded(r) for r in rows], 'total': total, 'page': page}


@router.get('/jobs/{job_id}')
def job(job_id: int):
    with connection() as conn:
        row = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Job not found')
        return {**decoded(row), 'search_results': [dict(r) for r in conn.execute('SELECT * FROM discovery_search_results WHERE job_id=? ORDER BY id', (job_id,))],
                'attempts': [dict(r) for r in conn.execute('SELECT * FROM discovery_attempts WHERE job_id=? ORDER BY id', (job_id,))],
                'activity': [dict(r) for r in conn.execute('SELECT * FROM discovery_activity WHERE job_id=? ORDER BY id', (job_id,))]}


@router.post('/jobs/{job_id}/cancel')
async def cancel(job_id: int, user=Depends(admin)):
    status = await cancel_job(job_id, user['email'])
    if status is None:
        raise HTTPException(404, 'Job not found')
    return {'id': job_id, 'status': status}


@router.post('/provider/check')
async def check_provider(payload: Research):
    try:
        account = await verify_account()
        record_provider_check('Ready')
    except SearchError as exc:
        record_provider_check('Error', str(exc))
        raise HTTPException(422, str(exc))
    return {'status': 'Ready', 'checked_at': now(), 'account': account, 'searches_used': 0}


class ScheduleFilters(BaseModel):
    product: str = Field('', max_length=100)
    city: str = Field('', max_length=100)
    keywords: str = Field('', max_length=200)
    mode: Optional[Literal['automatic', 'seeds']] = None
    rotation_enabled: bool = False


class ScheduleInput(BaseModel):
    enabled: bool
    interval_seconds: int = Field(3600, ge=60, le=2592000)
    filters: ScheduleFilters


@router.post('/schedule')
def configure_schedule(payload: ScheduleInput, user=Depends(admin)):
    config = configuration()
    if payload.enabled:
        mode = 'automatic' if payload.filters.rotation_enabled else research_mode(payload.filters.model_dump(), config)
        if mode == 'automatic' and not payload.filters.rotation_enabled and not any(getattr(payload.filters, k).strip() for k in ('product', 'city', 'keywords')):
            raise HTTPException(422, 'Recurring discovery requires a product, city or keywords')
        if mode == 'automatic' and not config['automatic_ready']:
            raise HTTPException(422, ' '.join(config['setup_errors']) or 'Search provider not configured.')
        if mode == 'seeds' and not config['seed_urls']:
            raise HTTPException(422, 'Configure DuckDuckGo via SerpApi or permitted seeds before enabling recurring discovery')
    return save_schedule(payload.model_dump(), user['email'])


@router.post('/schedule/pause')
def pause_schedule(user=Depends(admin)):
    existing = schedule_status()
    return save_schedule({'enabled': False, 'interval_seconds': existing['interval_seconds'], 'filters': existing['filters']}, user['email'])


@router.post('/schedule/resume')
async def resume_schedule(user=Depends(admin)):
    if not configuration()['automatic_ready']:
        raise HTTPException(422, 'Configure DuckDuckGo/SerpApi before resuming automatic research.')
    try:
        await verify_account()  # Free account check only; activation never searches.
    except SearchError as exc:
        raise HTTPException(422, str(exc))
    reason = usage_status()['paused_reason']
    if reason:
        raise HTTPException(422, reason)
    existing = schedule_status()
    return save_schedule({'enabled': True, 'interval_seconds': AUTOMATION_INTERVAL,
                          'filters': {**existing['filters'], 'mode': 'automatic', 'rotation_enabled': True}}, user['email'])


class Review(BaseModel):
    action: str = Field(pattern='^(review|dismiss|duplicate|reopen)$')
    linked_lead_id: Optional[int] = Field(default=None, ge=1)
    linked_vendor_id: Optional[int] = Field(default=None, ge=1)
    note: str = Field('', max_length=2000)


@router.post('/leads/{lead_id}/review')
def review(lead_id: int, payload: Review, user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute('SELECT * FROM discovery_leads WHERE id=?', (lead_id,)).fetchone()
        if not existing:
            raise HTTPException(404, 'Lead not found')
        if payload.action == 'duplicate':
            if bool(payload.linked_lead_id) == bool(payload.linked_vendor_id):
                raise HTTPException(422, 'Choose exactly one duplicate lead or vendor')
            if payload.linked_lead_id == lead_id:
                raise HTTPException(422, 'Cannot link a lead to itself')
            table, target = ('discovery_leads', payload.linked_lead_id) if payload.linked_lead_id else ('vendors', payload.linked_vendor_id)
            if not conn.execute(f'SELECT 1 FROM {table} WHERE id=?', (target,)).fetchone():
                raise HTTPException(404, 'Duplicate target not found')
        if payload.action == 'review' and payload.linked_vendor_id:
            if payload.linked_lead_id:
                raise HTTPException(422, 'Qualification linking requires one supplier record')
            if not conn.execute('SELECT 1 FROM vendors WHERE id=?', (payload.linked_vendor_id,)).fetchone():
                raise HTTPException(404, 'Supplier record not found')
        elif payload.action != 'duplicate' and (payload.linked_vendor_id or payload.linked_lead_id):
            raise HTTPException(422, 'Supplier linking is available during qualification review')
        status = {'review': 'Reviewed', 'dismiss': 'Dismissed', 'duplicate': 'Duplicate', 'reopen': 'Pending Review'}[payload.action]
        linked_vendor = payload.linked_vendor_id if payload.action == 'duplicate' else payload.linked_vendor_id or existing['linked_vendor_id']
        linked_lead = payload.linked_lead_id if payload.action == 'duplicate' else existing['linked_lead_id']
        conn.execute('UPDATE discovery_leads SET status=?,linked_lead_id=?,linked_vendor_id=?,updated_at=? WHERE id=?',
                     (status, linked_lead, linked_vendor, now(), lead_id))
        conn.execute('INSERT INTO discovery_activity(lead_id,actor,action,detail,at) VALUES(?,?,?,?,?)',
                     (lead_id, user['email'], status, payload.model_dump_json(), now()))
    return {'id': lead_id, 'status': status}
