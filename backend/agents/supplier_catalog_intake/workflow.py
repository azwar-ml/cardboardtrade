import asyncio
import datetime as dt
import hashlib
import json
import uuid
from typing import TypedDict
from urllib.parse import urlsplit
from langgraph.graph import StateGraph, START, END
from rapidfuzz.fuzz import ratio
from . import parsers, ai
from .normalization import normalize, header_mapping, identity, validate, key
from .storage import connection, now, dump, files_dir, audit, refresh_status, demo_allowed


def duplicates(conn, vendor, data, signature, row_id=None, job=None, target=None):
    matches, errors = [], []
    for item in conn.execute('SELECT id,data,identity FROM catalog_products WHERE vendor_id=?', (vendor,)):
        other = json.loads(item['data'])
        if item['identity'] == signature:
            matches.append({'type': 'Existing catalog offer', 'id': item['id'], 'name': other.get('name')})
            if target != item['id']: errors.append('Existing offer: choose explicit reviewed update or reject duplicate')
        elif data.get('vendor_sku') and other.get('vendor_sku') == data['vendor_sku']:
            matches.append({'type': 'SKU variation: compare specifications', 'id': item['id']})
        elif ratio(str(other.get('name', '')).lower(), str(data.get('name', '')).lower()) > 88:
            matches.append({'type': 'Similar description: review specifications', 'id': item['id']})
    if job:
        previous = conn.execute('SELECT id FROM catalog_rows WHERE job_id=? AND identity=? AND id<>? AND status<>\'Rejected\' ORDER BY ordinal LIMIT 1',
                                (job, signature, row_id or -1)).fetchone()
        if previous and (not row_id or previous[0] < row_id):
            matches.append({'type': 'Duplicate row in import', 'row_id': previous[0]})
            errors.append('Duplicate product in this import; reject repeated row')
    if data.get('vendor_sku'):
        for row in conn.execute('SELECT id,ref FROM items WHERE vendor_id=? AND vendor_sku=?', (vendor, data['vendor_sku'])):
            matches.append({'type': 'Existing ready-stock lot; catalog approval does not update stock', **dict(row)})
    return matches[:30], errors


async def website(url, mapping, limit):
    from crawlee import ConcurrencySettings
    from crawlee.crawlers import BasicCrawler
    from crawlee.storages import RequestQueue
    from agents.supplier_discovery.safety import permitted_page
    from agents.supplier_discovery.providers import configuration
    config = configuration()
    allowed = None if config['source_policy'] == 'public' else set(config['allowed_domains'])
    queue = await RequestQueue.open(name='catalog-' + uuid.uuid4().hex)
    crawler = BasicCrawler(request_manager=queue, max_request_retries=0, use_session_pool=False, retry_on_blocked=False,
        request_handler_timeout=dt.timedelta(seconds=90),
        concurrency_settings=ConcurrencySettings(min_concurrency=1,max_concurrency=1,desired_concurrency=1))
    result, errors = [], []
    @crawler.router.default_handler
    async def handle(context):
        html, final = await permitted_page(context.request.url, allowed, {})
        result.extend(parsers.parse_html(html, final, limit, mapping))
    @crawler.failed_request_handler
    async def failed(context, error):
        errors.append(str(error))
    try:
        await crawler.run([url])
        if errors or not result: raise ValueError('Permitted page retrieval failed; access restrictions were respected')
        return tuple(result)
    finally: await queue.drop()


class State(TypedDict, total=False):
    job: dict
    rows: list
    warnings: list
    texts: list


async def parse_node(state):
    job = state['job']
    with connection() as conn: control = dict(conn.execute('SELECT * FROM catalog_controls WHERE id=1').fetchone())
    mapping = json.loads(job['mapping'])
    if job['kind'] == 'url':
        rows, warnings, texts = await asyncio.wait_for(website(job['source_url'], mapping, control['max_rows']), 95)
    else:
        content = (files_dir() / job['stored_name']).read_bytes()
        rows, warnings, texts = await asyncio.wait_for(asyncio.to_thread(parsers.parse, content, job['kind'], control['max_rows'], mapping), 90)
    if not rows and texts and job['use_ai']:
        with connection() as conn:
            status = conn.execute('SELECT status FROM catalog_jobs WHERE id=?', (job['id'],)).fetchone()
        if not status or status[0] != 'Processing':
            return {'rows': [], 'warnings': ['Cancelled before optional AI analysis'], 'texts': texts}
        values, error = await asyncio.to_thread(ai.extract, job['id'], texts)
        rows.extend(values)
        if error: warnings.append('AI unavailable: ' + error)
    if not rows: warnings.append('No publishable rows extracted. Review the original source and request a corrected structured catalog.')
    return {'rows': rows, 'warnings': warnings, 'texts': texts}


def validate_node(state):
    job, rows = state['job'], state['rows']
    mapping = json.loads(job['mapping'])
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        active = conn.execute('SELECT status FROM catalog_jobs WHERE id=?', (job['id'],)).fetchone()
        if not active or active[0] != 'Processing': return {}
        conn.execute('DELETE FROM catalog_rows WHERE job_id=?', (job['id'],))
        supplier = conn.execute('SELECT * FROM vendors WHERE id=?', (job['vendor_id'],)).fetchone()
        supplier_names = {key(supplier[f]) for f in ('name','code','legal_name') if supplier[f]}
        known_names = {key(v[f]) for v in conn.execute('SELECT name,code,legal_name FROM vendors') for f in ('name','code','legal_name') if v[f]}
        skipped = 0
        for index, item in enumerate(rows, 1):
            vendor_names = [key(v) for h,v in item['raw'].items() if key(h) in ('vendor','supplier','supplier name','vendor name','company','supplier code') and v]
            mismatch = any(v not in supplier_names for v in vendor_names)
            if mismatch and all(v in known_names for v in vendor_names):
                skipped += 1
                continue
            data, errors, warnings = normalize(item['raw'], header_mapping(item['raw'], mapping), job['created_at'])
            if mismatch: errors.append('Source supplier identity differs from selected vendor; reject and import under the correct existing supplier')
            demo = 'demo' in job['name'].lower() or any('demo' in str(v).lower() for h,v in item['raw'].items() if key(h) in ('notes','price source'))
            if demo and not demo_allowed(): errors.append('DEMO input is permitted only in an explicitly enabled disposable QA database')
            signature = identity(data)
            matches, conflicts = duplicates(conn, job['vendor_id'], data, signature, job=job['id'])
            source = {**item['source'], 'document': job['name'], 'source_url': job['source_url'],
                      'observed_at': job['created_at'], 'label': 'Supplier claim; catalog approval is not independent verification',
                      'quality': 'Direct tabular source' if 'extraction' not in item['source'] else 'AI suggestion with exact quotations'}
            source['identity_error'] = mismatch
            source['demo'] = demo
            source['content_sha256'] = hashlib.sha256(source.get('text', dump(item['raw'])).encode()).hexdigest()
            conn.execute('INSERT INTO catalog_rows(job_id,ordinal,source,raw,data,errors,warnings,matches,identity) VALUES(?,?,?,?,?,?,?,?,?)',
                         (job['id'], index, dump(source), dump(item['raw']), dump(data), dump(errors + conflicts), dump(warnings), dump(matches), signature))
        if skipped: state['warnings'].append(f'{skipped} rows for other known suppliers excluded; supplier offers were kept separate')
        conn.execute("UPDATE catalog_jobs SET status='Needs Review',stage='Review',parsed_count=?,warnings=?,updated_at=? WHERE id=?",
                     (len(rows) - skipped, dump(state['warnings']), now(), job['id']))
        audit(conn, job['id'], job['created_by'], 'Extracted', {'products': len(rows), 'warnings': state['warnings']})
    return {}


builder = StateGraph(State)
builder.add_node('parse', parse_node)
builder.add_node('validate', validate_node)
builder.add_edge(START, 'parse')
builder.add_edge('parse', 'validate')
builder.add_edge('validate', END)
graph = builder.compile()


async def run_job(job_id):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute("UPDATE catalog_jobs SET status='Processing',stage='Parsing',error=NULL,updated_at=? WHERE id=? AND status='Queued'", (now(), job_id)).rowcount:
            return
        job = dict(conn.execute('SELECT * FROM catalog_jobs WHERE id=?', (job_id,)).fetchone())
    try:
        await graph.ainvoke({'job': job})
    except Exception as exc:
        # Parser errors are intentionally generic: no internal paths or document internals.
        message = str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else 'Catalog processing failed; malformed, restricted or timed-out source. Correct it and retry.'
        message = ai.provider.safe_error(message)
        if ':\\' in message or '/Users/' in message: message = 'Catalog parsing failed; inspect and correct the source file'
        with connection() as conn:
            conn.execute("UPDATE catalog_jobs SET status='Failed',stage='Failed',error=?,updated_at=? WHERE id=? AND status='Processing'", (message[:1000], now(), job_id))
            audit(conn, job_id, job['created_by'], 'Processing failed', {'error': message[:1000]})


def recover():
    with connection() as conn:
        # Parsing writes are atomic. Requeue interrupted work, preserving all review decisions.
        conn.execute("UPDATE catalog_jobs SET status='Queued',stage='Recovered after restart',updated_at=? WHERE status='Processing'", (now(),))


async def worker():
    while True:
        with connection() as conn:
            paused = conn.execute('SELECT paused FROM catalog_controls WHERE id=1').fetchone()[0]
            row = conn.execute("SELECT id FROM catalog_jobs WHERE status='Queued' ORDER BY created_at LIMIT 1").fetchone() if not paused else None
        if row: await run_job(row[0])
        else: await asyncio.sleep(1)


def publish(conn, job_id, ids, user):
    job = conn.execute('SELECT * FROM catalog_jobs WHERE id=?', (job_id,)).fetchone()
    if not job or job['status'] in ('Cancelled', 'Processing', 'Queued', 'Failed'): raise ValueError('Import is not ready to publish')
    vendor = conn.execute('SELECT status FROM vendors WHERE id=?', (job['vendor_id'],)).fetchone()
    if not vendor or vendor[0] == 'blocked': raise ValueError('Supplier is blocked')
    for row_id in ids:
        row = conn.execute('SELECT * FROM catalog_rows WHERE id=? AND job_id=?', (row_id, job_id)).fetchone()
        if not row or row['status'] != 'Approved': raise ValueError('Every selected product must be Admin-approved')
        data, errors, _ = validate(json.loads(row['data']))
        _, conflicts = duplicates(conn, job['vendor_id'], data, identity(data), row_id, job_id, row['target_id'])
        if errors or conflicts: raise ValueError('; '.join(errors + conflicts))
        source = json.loads(row['source'])
        if source.get('demo') and not demo_allowed(): raise ValueError('Demo evidence cannot be published to business inventory')
        source['job_id'], source['row_id'] = job_id, row_id
        if row['target_id']:
            previous = conn.execute('SELECT * FROM catalog_products WHERE id=? AND vendor_id=?', (row['target_id'], job['vendor_id'])).fetchone()
            if not previous: raise ValueError('Update target does not belong to this supplier')
            old = json.loads(previous['data'])
            if previous['updated_at'] > job['created_at'] or str(old.get('observed_at', '')) > str(data.get('observed_at', '')):
                raise ValueError('A newer offer exists; import fresh evidence before updating')
            fields = json.loads(row['update_fields'])
            if not fields: raise ValueError('Select exact fields for the reviewed update')
            for field in fields: old[field] = data.get(field)
            merged, invalid, _ = validate(old)
            if invalid: raise ValueError('; '.join(invalid))
            audit(conn, job_id, user, 'Offer updated', {'before': json.loads(previous['data']), 'fields': fields, 'source': source}, row_id)
            conn.execute('UPDATE catalog_products SET data=?,source=?,row_id=?,updated_at=?,identity=? WHERE id=?',
                (dump(merged), dump(source), row_id, now(), identity(merged), row['target_id']))
            product_id = row['target_id']
        else:
            product_id = conn.execute('INSERT INTO catalog_products(vendor_id,identity,data,source,row_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                          (job['vendor_id'], row['identity'], row['data'], dump(source), row_id, now(), now())).lastrowid
        conn.execute("UPDATE catalog_rows SET status='Published',published_id=?,version=version+1 WHERE id=?", (product_id, row_id))
        audit(conn, job_id, user, 'Published', {'catalog_product_id': product_id, 'source': source}, row_id)
    refresh_status(conn, job_id)
