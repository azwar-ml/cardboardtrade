import csv
import hashlib
import io
import json
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Optional, List, Dict, Literal
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from starlette.datastructures import UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, ConfigDict
from agents.supplier_discovery.api import admin
from .storage import connection, now, dump, decode, files_dir, audit, refresh_status, demo_allowed
from .normalization import Product, taxonomy, header_mapping, validate, identity
from . import parsers, workflow, ai

router = APIRouter(prefix='/api/v1/catalog', dependencies=[Depends(admin)])


def required(conn, table, identity):
    row = conn.execute('SELECT * FROM ' + table + ' WHERE id=?', (identity,)).fetchone()
    if row is None: raise HTTPException(404, 'Record not found')
    return row


def create(vendor, name, kind, content, url, user, use_ai=False, refresh=False):
    fingerprint = hashlib.sha256(content if content is not None else (url + (uuid.uuid4().hex if refresh else '')).encode()).hexdigest()
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        supplier = required(conn, 'vendors', vendor)
        if supplier['status'] == 'blocked': raise HTTPException(409, 'Blocked supplier cannot import catalogs')
        duplicate = conn.execute('SELECT id FROM catalog_jobs WHERE vendor_id=? AND fingerprint=?', (vendor, fingerprint)).fetchone()
        if duplicate: return {'id': duplicate[0], 'duplicate': True}
        queued = conn.execute("SELECT count(*) FROM catalog_jobs WHERE status IN ('Queued','Processing')").fetchone()[0]
        if queued >= 20: raise HTTPException(429, 'Catalog queue is full; try after existing jobs finish')
        job = uuid.uuid4().hex
        stored = fingerprint + '.' + kind if content is not None else None
        if content is not None:
            target = files_dir() / stored
            if not target.exists(): target.write_bytes(content)
        mapping = conn.execute('SELECT mapping FROM catalog_mappings WHERE vendor_id=?', (vendor,)).fetchone()
        conn.execute('INSERT INTO catalog_jobs(id,vendor_id,fingerprint,name,kind,source_url,stored_name,size,created_by,created_at,updated_at,mapping,use_ai) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                     (job, vendor, fingerprint, name, kind, url, stored, len(content or b''), user['id'], now(), now(), mapping[0] if mapping else '{}', int(use_ai)))
        audit(conn, job, user['id'], 'Import queued', {'name': name, 'kind': kind, 'sha256': fingerprint, 'vendor_id': vendor})
    return {'id': job, 'duplicate': False}


@router.get('/summary')
def summary():
    with connection() as conn:
        counts = dict(conn.execute('SELECT status,count(*) FROM catalog_jobs GROUP BY status'))
        reviews = conn.execute("SELECT count(*) FROM catalog_rows WHERE status IN ('Needs Review','Correction Requested')").fetchone()[0]
        total_rows = conn.execute('SELECT count(*) FROM catalog_rows').fetchone()[0]
        products = conn.execute('SELECT count(*) FROM catalog_products').fetchone()[0]
        recent = [dict(r) for r in conn.execute('SELECT j.id,v.name,j.status,j.parsed_count,j.updated_at FROM catalog_jobs j JOIN vendors v ON v.id=j.vendor_id ORDER BY j.updated_at DESC LIMIT 6')]
        activity = [dict(r) for r in conn.execute('SELECT action,created_at,job_id FROM catalog_audit ORDER BY id DESC LIMIT 8')]
        controls = dict(conn.execute('SELECT * FROM catalog_controls WHERE id=1').fetchone())
        usage = [dict(r) for r in conn.execute('SELECT key_name,model,status,requests,input_tokens,output_tokens,estimated_cost_usd,error,created_at FROM catalog_ai_usage ORDER BY id DESC LIMIT 10')]
    return {'imports': sum(counts.values()), 'extracted': total_rows, 'awaiting_review': reviews, 'approved_products': products,
            'failed': counts.get('Failed', 0), 'active': counts.get('Queued', 0) + counts.get('Processing', 0),
            'status': 'Paused' if controls['paused'] else 'Processing' if counts.get('Processing') else 'Ready',
            'recent': recent, 'activity': activity, 'controls': controls, 'ai': ai.configuration(), 'usage': usage}


@router.get('/options')
def options():
    with connection() as conn:
        vendors = [dict(r) for r in conn.execute('SELECT id,code,name,website,status FROM vendors ORDER BY name')]
        # Qualification results are readable independently of catalog approval.
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for vendor in vendors:
            vendor['verification_status'] = 'Not evaluated / no linked Agent #2 evaluation'
            if 'qualification_jobs' in tables:
                run = conn.execute('''SELECT j.status,j.review_status,j.report,j.finished_at FROM qualification_jobs j
                    JOIN discovery_leads l ON l.id=j.lead_id WHERE l.linked_vendor_id=? AND j.kind='verification'
                    ORDER BY j.id DESC LIMIT 1''', (vendor['id'],)).fetchone()
                if run:
                    report = json.loads(run['report'] or '{}')
                    vendor['verification_status'] = run['status'] + ' · ' + run['review_status']
                    vendor['verification_summary'] = report.get('summary', 'Evaluation incomplete')
    return {'vendors': vendors, 'categories': [line for line, _ in taxonomy()], 'fields': list(Product.model_fields),
            'verification_note': 'Catalog approval is separate from Agent #2 supplier verification. Open the supplier verification dashboard for current evidence.'}


@router.post('/imports')
async def upload(request: Request, user=Depends(admin)):
    form = await request.form(max_files=1, max_fields=2, max_part_size=2048)
    file = form.get('file')
    if not isinstance(file, UploadFile): raise HTTPException(422, 'Choose exactly one catalog file')
    try: vendor_id = int(str(form.get('vendor_id', '')))
    except ValueError: raise HTTPException(422, 'Select an existing supplier')
    use_ai = str(form.get('use_ai', 'false')).lower() == 'true'
    with connection() as conn: size = conn.execute('SELECT max_file_mb FROM catalog_controls WHERE id=1').fetchone()[0] * 1024 * 1024
    content = await file.read(size + 1)
    await file.close()
    if len(content) > size: raise HTTPException(413, 'Catalog exceeds configured file-size limit')
    name = Path((file.filename or 'catalog').replace('\\', '/')).name[:150]
    try: kind = parsers.check_file(name, content)
    except ValueError as exc: raise HTTPException(422, str(exc))
    return create(vendor_id, name, kind, content, None, user, use_ai)


class URLImport(BaseModel):
    vendor_id: int
    url: str = Field(max_length=2000)
    use_ai: bool = False
    reviewed_refresh: bool = False


@router.post('/url')
async def url_import(body: URLImport, user=Depends(admin)):
    from agents.supplier_discovery.safety import resolve_public
    import asyncio
    try: await asyncio.to_thread(resolve_public, body.url)
    except Exception: raise HTTPException(422, 'Only permitted public HTTP(S) URLs may be imported')
    if body.reviewed_refresh:
        # A new explicitly requested observation of the same URL is a new review,
        # never an overwrite of previously published evidence.
        return create(body.vendor_id, urlsplit(body.url).hostname or 'Website', 'url',
                      None, body.url, user, body.use_ai, refresh=True)
    return create(body.vendor_id, urlsplit(body.url).hostname or 'Website', 'url', None, body.url, user, body.use_ai)


@router.get('/imports')
def imports(page: int = Query(1, ge=1), status: Optional[str] = None):
    where, values = ('WHERE j.status=?', [status]) if status else ('', [])
    with connection() as conn:
        total = conn.execute('SELECT count(*) FROM catalog_jobs j ' + where, values).fetchone()[0]
        rows = conn.execute('SELECT j.*,v.name supplier FROM catalog_jobs j JOIN vendors v ON v.id=j.vendor_id ' + where + ' ORDER BY j.created_at DESC LIMIT 20 OFFSET ?', values + [(page-1)*20]).fetchall()
    return {'total': total, 'rows': [decode(r) for r in rows]}


@router.get('/imports/{job_id}')
def detail(job_id: str):
    with connection() as conn:
        row = decode(required(conn, 'catalog_jobs', job_id))
        row['counts'] = dict(conn.execute('SELECT status,count(*) FROM catalog_rows WHERE job_id=? GROUP BY status', (job_id,)))
        row['history'] = [dict(r) for r in conn.execute('SELECT action,detail,created_at,user_id,row_id FROM catalog_audit WHERE job_id=? ORDER BY id DESC LIMIT 100', (job_id,))]
    return row


@router.get('/imports/{job_id}/source')
def source(job_id: str):
    with connection() as conn: job = required(conn, 'catalog_jobs', job_id)
    if not job['stored_name']: raise HTTPException(404, 'Website import has no uploaded file; original URL is in provenance')
    return FileResponse(files_dir() / job['stored_name'], filename=job['name'], media_type='application/octet-stream', headers={'X-Content-Type-Options': 'nosniff'})


class Control(BaseModel):
    paused: bool
    max_rows: int = Field(2000, ge=1, le=10000)
    max_file_mb: int = Field(10, ge=1, le=20)


@router.post('/controls')
def controls(body: Control, user=Depends(admin)):
    with connection() as conn:
        conn.execute('UPDATE catalog_controls SET paused=?,max_rows=?,max_file_mb=? WHERE id=1', (int(body.paused), body.max_rows, body.max_file_mb))
        audit(conn, None, user['id'], 'Controls updated', body.model_dump())
    return {'ok': True}


class JobAction(BaseModel):
    action: Literal['cancel', 'retry', 'remap']
    mapping: Dict[str, str] = Field(default_factory=dict)


@router.post('/imports/{job_id}/action')
def job_action(job_id: str, body: JobAction, user=Depends(admin)):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        job = required(conn, 'catalog_jobs', job_id)
        if body.action == 'cancel':
            if job['status'] not in ('Queued', 'Processing'): raise HTTPException(409, 'Only active jobs can be cancelled')
            conn.execute("UPDATE catalog_jobs SET status='Cancelled',stage='Cancelled',updated_at=? WHERE id=?", (now(), job_id))
        else:
            decisions = conn.execute("SELECT 1 FROM catalog_rows WHERE job_id=? AND status NOT IN ('Needs Review','Correction Requested')", (job_id,)).fetchone()
            if decisions: raise HTTPException(409, 'Reviewed imports cannot be reprocessed; preserve decisions and submit a revised source')
            if job['status'] in ('Queued','Processing'): raise HTTPException(409, 'Import is already active')
            if body.action == 'remap':
                if any(v not in Product.model_fields and v != 'unit' for v in body.mapping.values()): raise HTTPException(422, 'Unknown mapping field')
                if len(body.mapping) > 150: raise HTTPException(422, 'Too many mapping fields')
                conn.execute('UPDATE catalog_jobs SET mapping=? WHERE id=?', (dump(body.mapping), job_id))
                conn.execute('INSERT OR REPLACE INTO catalog_mappings VALUES(?,?,?)', (job['vendor_id'], dump(body.mapping), now()))
            conn.execute("UPDATE catalog_jobs SET status='Queued',stage='Queued',error=NULL,updated_at=? WHERE id=?", (now(), job_id))
        audit(conn, job_id, user['id'], body.action, body.model_dump())
    return {'ok': True}


@router.get('/rows')
def rows(q: str = '', vendor: Optional[int] = None, category: str = '', status: str = '', job: str = '', page: int = Query(1, ge=1)):
    conditions, args = [], []
    for expression, value in [('j.vendor_id=?', vendor), ('r.status=?', status), ('r.job_id=?', job), ("json_extract(r.data,'$.line')=?", category)]:
        if value: conditions.append(expression); args.append(value)
    if q:
        conditions.append('(r.data LIKE ? OR v.name LIKE ?)'); args.extend(['%' + q[:200] + '%'] * 2)
    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    base = ' FROM catalog_rows r JOIN catalog_jobs j ON j.id=r.job_id JOIN vendors v ON v.id=j.vendor_id'
    with connection() as conn:
        count = conn.execute('SELECT count(*)' + base + where, args).fetchone()[0]
        records = conn.execute('SELECT r.*,v.name supplier,j.vendor_id' + base + where + ' ORDER BY r.id DESC LIMIT 20 OFFSET ?', args + [(page-1)*20]).fetchall()
    return {'total': count, 'rows': [decode(r) for r in records]}


class Edit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: int
    data: dict
    reason: str = Field(min_length=3, max_length=1000)
    target_id: Optional[int] = None
    update_fields: List[str] = Field(default_factory=list, max_length=60)


@router.post('/rows/{row_id}/edit')
def edit(row_id: int, body: Edit, user=Depends(admin)):
    if any(f not in Product.model_fields for f in body.data) or any(f not in Product.model_fields for f in body.update_fields):
        raise HTTPException(422, 'Unknown product field')
    if len(dump(body.data)) > 50000: raise HTTPException(422, 'Product data too large')
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = required(conn, 'catalog_rows', row_id)
        job = required(conn, 'catalog_jobs', row['job_id'])
        if row['status'] == 'Published' or job['status'] in ('Cancelled','Processing','Queued','Failed'): raise HTTPException(409, 'Product is not editable')
        if row['version'] != body.version: raise HTTPException(409, 'Product changed; refresh before editing')
        if body.target_id:
            target = required(conn, 'catalog_products', body.target_id)
            if target['vendor_id'] != job['vendor_id']: raise HTTPException(422, 'Update target belongs to another supplier')
        clean, errors, warnings = validate(body.data)
        evidence = json.loads(row['source'])
        if evidence.get('identity_error'): errors.append('Source supplier identity differs from selected vendor; reject and import under the correct existing supplier')
        if evidence.get('demo') and not demo_allowed(): errors.append('DEMO input is permitted only in an explicitly enabled disposable QA database')
        signature = identity(clean)
        matches, conflicts = workflow.duplicates(conn, job['vendor_id'], clean, signature, row_id, row['job_id'], body.target_id)
        conn.execute("UPDATE catalog_rows SET data=?,errors=?,warnings=?,matches=?,identity=?,status='Needs Review',version=version+1,target_id=?,update_fields=? WHERE id=?",
                     (dump(clean), dump(errors + conflicts), dump(warnings), dump(matches), signature, body.target_id, dump(body.update_fields), row_id))
        audit(conn, row['job_id'], user['id'], 'Admin correction', {'before': json.loads(row['data']), 'after': clean, 'reason': body.reason,
              'target_id': body.target_id, 'update_fields': body.update_fields}, row_id)
        refresh_status(conn, row['job_id'])
    return {'errors': errors + conflicts, 'warnings': warnings}


class Decision(BaseModel):
    ids: List[int] = Field(min_length=1, max_length=100)
    action: Literal['approve', 'reject', 'correction', 'publish']
    note: str = Field(min_length=3, max_length=1000)


@router.post('/imports/{job_id}/review')
def review(job_id: str, body: Decision, user=Depends(admin)):
    if len(body.ids) != len(set(body.ids)): raise HTTPException(422, 'Repeated product selection')
    try:
        with connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            job = required(conn, 'catalog_jobs', job_id)
            if body.action == 'publish': workflow.publish(conn, job_id, body.ids, user['id'])
            else:
                if job['status'] in ('Cancelled', 'Failed', 'Queued', 'Processing'): raise ValueError('Import is not ready for review')
                for row_id in body.ids:
                    row = required(conn, 'catalog_rows', row_id)
                    if row['job_id'] != job_id or row['status'] == 'Published': raise ValueError('Invalid review selection')
                    if body.action == 'approve':
                        _, errors, _ = validate(json.loads(row['data']))
                        _, conflicts = workflow.duplicates(conn, job['vendor_id'], json.loads(row['data']), row['identity'], row_id, job_id, row['target_id'])
                        if errors or conflicts or json.loads(row['errors']): raise ValueError('Resolve all validation errors and duplicate conflicts before approval')
                    status = {'approve': 'Approved', 'reject': 'Rejected', 'correction': 'Correction Requested'}[body.action]
                    conn.execute('UPDATE catalog_rows SET status=?,version=version+1 WHERE id=?', (status, row_id))
                    audit(conn, job_id, user['id'], status, {'note': body.note}, row_id)
                refresh_status(conn, job_id)
    except (ValueError, sqlite3.IntegrityError) as exc:
        raise HTTPException(409, str(exc) if isinstance(exc, ValueError) else 'Publication conflict; refresh and review duplicates')
    return {'ok': True}


@router.get('/products')
def products(q: str = '', vendor: Optional[int] = None, page: int = Query(1, ge=1)):
    where, args = [], []
    if vendor: where.append('p.vendor_id=?'); args.append(vendor)
    if q: where.append('(p.data LIKE ? OR v.name LIKE ?)'); args.extend(['%' + q[:200] + '%'] * 2)
    clause = ' WHERE ' + ' AND '.join(where) if where else ''
    with connection() as conn:
        total = conn.execute('SELECT count(*) FROM catalog_products p JOIN vendors v ON v.id=p.vendor_id' + clause, args).fetchone()[0]
        result = conn.execute('SELECT p.*,v.name supplier FROM catalog_products p JOIN vendors v ON v.id=p.vendor_id' + clause + ' ORDER BY v.name,p.id DESC LIMIT 20 OFFSET ?', args + [(page-1)*20]).fetchall()
    return {'total': total, 'rows': [decode(r) for r in result]}


@router.get('/export')
def export():
    output = io.StringIO()
    writer = csv.writer(output)
    fields = ['supplier', 'vendor_sku', 'name', 'line', 'price', 'currency', 'price_unit', 'qty', 'availability']
    writer.writerow(fields)
    with connection() as conn:
        for row in conn.execute('SELECT p.data,v.name FROM catalog_products p JOIN vendors v ON v.id=p.vendor_id LIMIT 10000'):
            data = {**json.loads(row['data']), 'supplier': row['name']}
            values = [str(data.get(f) if data.get(f) is not None else '') for f in fields]
            writer.writerow(["'" + v if v.lstrip().startswith(('=', '+', '-', '@')) else v for v in values])
    return Response(output.getvalue(), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="supplier-catalog.csv"'})
