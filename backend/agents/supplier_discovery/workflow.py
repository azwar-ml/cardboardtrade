import asyncio
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import uuid
from typing import Any
from typing_extensions import TypedDict
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

from crawlee.crawlers import BasicCrawler
from crawlee import ConcurrencySettings, service_locator
from crawlee.storages import RequestQueue
from crawlee.configuration import Configuration
from langgraph.graph import StateGraph, START, END

from .storage import connection, now, domain, save_lead, sync_submissions
from .safety import permitted_page, UnsafeURL
from .providers import configuration, duckduckgo_search, fingerprint, verify_account, usage_status, SearchPaused, note_credit_pause
from .scheduling import ensure_schedule, schedule_status, future, research_mode, rotating_criteria, ROTATION
from .extraction import extract, validate
from .control import Control, JobCancelled, current, check

running_jobs = {}
last_account_monitor = None


async def monitor_account():
    global last_account_monitor
    config = configuration()
    if not config['search_configured']:
        return
    account = usage_status()['account']
    checked = (account or {}).get('checked_at', '')
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    if checked > cutoff and (account or {}).get('account_status') and 'plan_renewal_date' in account:
        return
    if last_account_monitor and last_account_monitor > cutoff:
        return
    last_account_monitor = now()  # Bound failed free checks too; never hammer the provider.
    await verify_account()


def recently_researched(url, config):
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=config['recheck_seconds'])).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    with connection() as conn:
        return bool(conn.execute("""SELECT 1 FROM discovery_sources s JOIN discovery_leads l ON l.id=s.lead_id
          WHERE l.domain=? AND s.source_type='Automated Discovery' AND s.accessed_at>? LIMIT 1""", (domain(url), cutoff)).fetchone()
          or conn.execute("SELECT 1 FROM discovery_attempts WHERE url=? AND status IN ('Successful','Duplicate') AND accessed_at>?", (url, cutoff)).fetchone())

service_locator.set_configuration(Configuration(persist_storage=False, crawlee_write_metadata=False))


class State(TypedDict, total=False):
    job_id: int
    filters: dict[str, Any]
    urls: list[str]
    pages: list[dict]
    candidates: list[dict]
    search_results: list[dict]
    recheck_domains: list[str]


def stage(job_id, name):
    check()
    with connection() as conn:
        conn.execute("UPDATE discovery_jobs SET stage=? WHERE id=? AND status='Running'", (name, job_id))
        conn.execute('INSERT INTO discovery_activity(job_id,actor,action,at) VALUES(?,?,?,?)', (job_id, 'discovery', name, now()))


def attempt(job_id, url, status, detail, lead_id=None):
    with connection() as conn:
        conn.execute('INSERT INTO discovery_attempts(job_id,lead_id,url,status,detail,accessed_at) VALUES(?,?,?,?,?,?)',
                     (job_id, lead_id, url, status, detail[:1000], now()))


def record_provider_check(status, error=None, result_count=0):
    with connection() as conn:
        conn.execute("""INSERT INTO discovery_provider_check(id,fingerprint,status,checked_at,error,result_count) VALUES(1,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,status=excluded.status,checked_at=excluded.checked_at,error=excluded.error,result_count=excluded.result_count""",
                     (fingerprint(), status, now(), error, result_count))


async def search(state):
    stage(state['job_id'], 'Searching permitted sources')
    config = configuration()
    filters = state['filters']
    mode = filters.get('mode') or ('manual' if filters.get('seed_urls') else 'automatic' if config['search_provider'] == 'duckduckgo' else 'seeds')
    urls = list(filters.get('seed_urls') or (config['seed_urls'] if mode != 'automatic' else []))
    results = []
    recheck_domains = []
    if mode == 'automatic':
        if not config['automatic_ready']:
            raise ValueError(' '.join(config['setup_errors']) or 'DuckDuckGo via SerpApi is not configured.')
        try:
            query, results = await duckduckgo_search(filters)
        except Exception as exc:
            record_provider_check('Error', str(exc))
            raise
        record_provider_check('Ready', result_count=len(results))
        if any(r.get('cached') for r in results):
            stage(state['job_id'], 'Reusing saved DuckDuckGo organic results; no new search request')
        seen_hosts = set()
        for result in results:
            check()
            url = result['url']
            reason = ''
            try:
                parsed = urlsplit(url)
                if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 80 if parsed.scheme == 'http' else 443):
                    reason = 'Unsafe or unsupported search result URL'
                elif domain(url) in seen_hosts:
                    reason = 'Duplicate company domain in search results'
                elif domain(url) in {'facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'alibaba.com', 'daraz.pk', 'duckduckgo.com', 'serpapi.com'}:
                    reason = 'Directory, social, marketplace or search-engine result'
                elif not re.search(r'packag|corrugat|cardboard|carton|boxes|paperboard', result['title'] + ' ' + result['snippet'], re.I):
                    reason = 'No packaging relevance in organic search result'
                elif re.search(r'\b(directory|jobs|salary)\b|^top\s+\d', result['title'], re.I):
                    reason = 'Listing or irrelevant search result'
                elif config['source_policy'] == 'allowlist' and domain(url) not in config['allowed_domains']:
                    reason = 'Search result domain is not permitted by the configured allowlist'
                elif len(urls) >= config['max_pages']:
                    reason = 'Per-job page limit reached'
                else:
                    url = urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or '/', urlencode([(k, v) for k, v in parse_qsl(parsed.query) if not k.lower().startswith('utm_') and k.lower() not in ('gclid', 'fbclid')]), ''))
                    if recently_researched(url, config):
                        reason = 'Already researched recently; seven-day crawl cooldown applied'
            except ValueError:
                reason = 'Invalid search result URL'
            with connection() as conn:
                conn.execute('''INSERT INTO discovery_search_results(job_id,provider,query,url,title,snippet,disposition,accessed_at)
                  VALUES(?,'duckduckgo',?,?,?,?,?,?)''', (state['job_id'], query, url, result['title'], result['snippet'], reason or 'Queued for guarded crawl', now()))
            if reason:
                attempt(state['job_id'], url, 'Skipped', reason)
            elif url not in urls:
                seen_hosts.add(domain(url))
                urls.append(url)
        stage(state['job_id'], f'Search returned {len(results)} results; {len(urls)} queued for guarded crawling')
    if filters.get('scheduled'):
        # Fill remaining crawl capacity with due existing suppliers; no extra search credit.
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        with connection() as conn:
            due = conn.execute("""SELECT l.website,MAX(s.accessed_at) last_seen FROM discovery_leads l
              JOIN discovery_sources s ON s.lead_id=l.id WHERE l.website!='' AND l.status IN ('Pending Review','Reviewed')
              AND s.source_type='Automated Discovery' GROUP BY l.id HAVING MAX(s.accessed_at)<=? ORDER BY last_seen LIMIT 20""", (cutoff,)).fetchall()
        for supplier in due:
            host = domain(supplier['website'])
            if host in {domain(u) for u in urls}:
                recheck_domains.append(host)
            elif len(urls) < config['max_pages']:
                urls.append(supplier['website'])
                recheck_domains.append(host)
    if filters.get('scheduled') and mode == 'seeds':
        urls = [u for u in urls if not recently_researched(u, config)]
    urls = list(dict.fromkeys(urls))[:config['max_pages']]
    if not urls:
        attempt(state['job_id'], '', 'Skipped', 'No permitted search results or configured seed URLs; no suppliers fabricated')
    return {'urls': urls, 'search_results': results, 'recheck_domains': recheck_domains}


async def crawl(state):
    stage(state['job_id'], 'Crawling permitted pages')
    pages, robots = [], {}
    allowed = set(configuration()['allowed_domains'])
    if state['filters'].get('mode') == 'automatic' and configuration()['source_policy'] == 'public':
        allowed = None
    if allowed is not None and state['filters'].get('source_permission_confirmed'):
        allowed.update(domain(url) for url in state['filters'].get('seed_urls', []))
    if not state['urls']:
        return {'pages': []}
    queue = await RequestQueue.open(name='discovery-' + uuid.uuid4().hex)
    crawler = BasicCrawler(request_manager=queue, max_request_retries=0,
                           use_session_pool=False, retry_on_blocked=False,
                           request_handler_timeout=dt.timedelta(seconds=120),
                           concurrency_settings=ConcurrencySettings(min_concurrency=1, max_concurrency=1, desired_concurrency=1))

    @crawler.router.default_handler
    async def handle(context):
        check()
        url = context.request.url
        try:
            html, final = await permitted_page(url, allowed, robots)
            check()
            reference = next((r for r in state.get('search_results', []) if r['url'] == url), None)
            pages.append({'url': final, 'html': html, 'accessed_at': now(), 'search_reference': reference})
            with connection() as conn:
                conn.execute("UPDATE discovery_search_results SET disposition='Crawled' WHERE job_id=? AND url=?", (state['job_id'], url))
        except JobCancelled:
            raise
        except Exception as exc:
            attempt(state['job_id'], url, 'Skipped' if isinstance(exc, UnsafeURL) else 'Failed', str(exc))
            with connection() as conn:
                conn.execute('UPDATE discovery_search_results SET disposition=? WHERE job_id=? AND url=?', (str(exc)[:1000], state['job_id'], url))

    @crawler.failed_request_handler
    async def failed(context, error):
        attempt(state['job_id'], context.request.url, 'Failed', str(error))

    try:
        await crawler.run(state['urls'])
    finally:
        await queue.drop()
    return {'pages': pages}


def extraction(state):
    stage(state['job_id'], 'Extracting structured information')
    candidates = []
    for page in state['pages']:
        try:
            data, evidence = extract(page['html'], page['url'])
            if page.get('search_reference'):
                evidence['search_reference'] = {'provider': 'duckduckgo', 'service': 'serpapi', **page['search_reference']}
            candidates.append({'data': data, 'evidence': evidence, 'url': page['url'], 'accessed_at': page['accessed_at']})
        except Exception as exc:
            attempt(state['job_id'], page['url'], 'Failed', 'Extraction: ' + str(exc))
    return {'candidates': candidates}


def validation(state):
    stage(state['job_id'], 'Validating source evidence')
    accepted = []
    for candidate in state['candidates']:
        # Scheduled rechecks can be outside this run's rotating city/category.
        criteria = {} if domain(candidate['url']) in state.get('recheck_domains', []) else state['filters']
        reason = validate(candidate['data'], criteria)
        if not candidate['evidence'].get('manufacturer_claim'):
            reason = 'No source evidence of manufacturer capability'
        keywords = re.findall(r'\w+', criteria.get('keywords', '').lower())
        if keywords and not all(word in candidate['evidence']['text_excerpt'].lower() for word in keywords):
            reason = 'Does not match research keywords'
        if reason:
            attempt(state['job_id'], candidate['url'], 'Skipped', reason)
        else:
            accepted.append(candidate)
    return {'candidates': accepted}


def persist(state):
    stage(state['job_id'], 'Checking duplicates and saving pending leads')
    for candidate in state['candidates']:
        with connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            check()
            if conn.execute('SELECT status FROM discovery_jobs WHERE id=?', (state['job_id'],)).fetchone()[0] != 'Running':
                raise JobCancelled('Job is no longer running')
            digest = hashlib.sha256(json.dumps(candidate['data'], sort_keys=True).encode()).hexdigest()
            evidence = {**candidate['evidence'], 'accessed_at': candidate['accessed_at']}
            lead_id, duplicate = save_lead(conn, candidate['data'], 'web:' + candidate['url'] + ':' + digest,
                                          'Automated Discovery', evidence, url=candidate['url'], job_id=state['job_id'])
        attempt(state['job_id'], candidate['url'], 'Duplicate' if duplicate else 'Successful', 'Saved unverified supplier evidence', lead_id)
    return {}


def finish(state):
    check()
    with connection() as conn:
        counts = dict(conn.execute('SELECT status,count(*) FROM discovery_attempts WHERE job_id=? GROUP BY status', (state['job_id'],)))
        failed = counts.get('Failed', 0)
        status = 'Failed' if failed and not (counts.get('Successful', 0) + counts.get('Duplicate', 0)) else 'Completed'
        conn.execute('''UPDATE discovery_jobs SET status=?,stage='Finished',finished_at=?,found=?,duplicates=?,failed=?,skipped=? WHERE id=? AND status='Running' ''',
                     (status, now(), counts.get('Successful', 0), counts.get('Duplicate', 0), failed, counts.get('Skipped', 0), state['job_id']))
    return {}


def graph():
    builder = StateGraph(State)
    nodes = [('search', search), ('crawl', crawl), ('extract', extraction), ('validate', validation), ('deduplicate_and_save', persist), ('finish', finish)]
    for name, function in nodes:
        builder.add_node(name, function)
    builder.add_edge(START, nodes[0][0])
    for (left, _), (right, _) in zip(nodes, nodes[1:]):
        builder.add_edge(left, right)
    builder.add_edge(nodes[-1][0], END)
    return builder.compile()  # No pickle/msgpack checkpointer; durable history is plain SQLite JSON.


def create_job(filters, actor, trigger='Manual'):
    filters = dict(filters)
    filters.setdefault('mode', 'manual' if filters.get('seed_urls') else 'automatic' if configuration()['search_provider'] == 'duckduckgo' else 'seeds')
    with connection() as conn:
        return conn.execute('''INSERT INTO discovery_jobs(trigger_type,actor,status,stage,filters,created_at)
          VALUES(?,?,'Queued','Queued',?,?)''', (trigger, actor, json.dumps(filters), now())).lastrowid


async def run_job(job_id):
    control = Control()
    token = current.set(control)
    task = None
    try:
        with connection() as conn:
            row = conn.execute('SELECT * FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()
            if not row or row['status'] != 'Queued':
                return
            conn.execute("UPDATE discovery_jobs SET status='Running' WHERE id=?", (job_id,))
        task = asyncio.create_task(graph().ainvoke({'job_id': job_id, 'filters': json.loads(row['filters'])}))
        running_jobs[job_id] = (task, control)
        await task
    except asyncio.CancelledError:
        control.cancel()
        with connection() as conn:
            cancelled = conn.execute('SELECT status FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()[0] == 'Cancelled'
            if not cancelled:
                conn.execute("UPDATE discovery_jobs SET status='Failed',stage='Interrupted',error='Service stopped',finished_at=? WHERE id=?", (now(), job_id))
        if not cancelled:
            raise
    except JobCancelled:
        pass
    except SearchPaused as exc:
        note_credit_pause(str(exc))
        with connection() as conn:
            conn.execute("UPDATE discovery_jobs SET status='Paused',stage='Credit protection',error=?,finished_at=? WHERE id=? AND status!='Cancelled'", (str(exc), now(), job_id))
            conn.execute("INSERT INTO discovery_activity(job_id,actor,action,detail,at) VALUES(?,'discovery','Credit protection paused research',?,?)", (job_id, str(exc), now()))
    except Exception as exc:
        attempt(job_id, '', 'Failed', 'Workflow error: ' + str(exc))
        with connection() as conn:
            conn.execute("UPDATE discovery_jobs SET status='Failed',stage='Failed',error=?,failed=failed+1,finished_at=? WHERE id=? AND status!='Cancelled'", (str(exc)[:1000], now(), job_id))
    finally:
        running_jobs.pop(job_id, None)
        current.reset(token)


async def cancel_job(job_id, actor):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT status FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()
        if not row:
            return None
        if row[0] not in ('Queued', 'Running'):
            return row[0]
        conn.execute("UPDATE discovery_jobs SET status='Cancelled',stage='Cancelled by Admin',finished_at=?,error=NULL WHERE id=?", (now(), job_id))
        counts = dict(conn.execute('SELECT status,count(*) FROM discovery_attempts WHERE job_id=? GROUP BY status', (job_id,)))
        conn.execute('UPDATE discovery_jobs SET found=?,duplicates=?,failed=?,skipped=? WHERE id=?', (counts.get('Successful', 0), counts.get('Duplicate', 0), counts.get('Failed', 0), counts.get('Skipped', 0), job_id))
        conn.execute("INSERT INTO discovery_activity(job_id,actor,action,at) VALUES(?,?,'Cancelled by Admin',?)", (job_id, actor, now()))
    running = running_jobs.get(job_id)
    if running:
        running[1].cancel()
        running[0].cancel()
        try:
            await running[0]
        except (asyncio.CancelledError, JobCancelled):
            pass
    return 'Cancelled'


async def scheduler_tick():
    sync_submissions()
    # Free account monitoring can release a credit pause after a provider-confirmed renewal.
    with connection() as conn:
        ensure_schedule(conn)
        enabled = conn.execute('SELECT enabled FROM discovery_schedule WHERE id=1').fetchone()[0]
    if enabled:
        try:
            await monitor_account()
        except Exception:
            pass  # A due uncached search still requires its own successful fresh account check.
    status = schedule_status()
    if not status['enabled'] or status['blocked_reason']:
        return None
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM discovery_schedule WHERE id=1').fetchone()
        if not row['enabled'] or not row['next_run_at'] or row['next_run_at'] > now():
            return None
        if conn.execute("SELECT 1 FROM discovery_jobs WHERE status IN ('Queued','Running')").fetchone():
            return None  # Keep the due time; retry once the existing job finishes.
        saved_filters = json.loads(row['filters'])
        filters = rotating_criteria(saved_filters) if saved_filters.get('rotation_enabled') else {**saved_filters, 'mode': research_mode(saved_filters), 'scheduled': True}
        job_id = conn.execute("""INSERT INTO discovery_jobs(trigger_type,actor,status,stage,filters,created_at)
          VALUES('Scheduled','scheduler','Queued','Queued',?,?)""", (json.dumps(filters), now())).lastrowid
        conn.execute('UPDATE discovery_schedule SET next_run_at=?,last_job_id=?,last_error=NULL WHERE id=1', (future(row['interval_seconds']), job_id))
        if saved_filters.get('rotation_enabled'):
            saved_filters['_rotation_cursor'] = (int(saved_filters.get('_rotation_cursor', 0)) + 1) % len(ROTATION)
            conn.execute('UPDATE discovery_schedule SET filters=? WHERE id=1', (json.dumps(saved_filters),))
    await run_job(job_id)
    with connection() as conn:
        error = conn.execute('SELECT error FROM discovery_jobs WHERE id=?', (job_id,)).fetchone()['error']
        conn.execute('UPDATE discovery_schedule SET last_error=? WHERE id=1', (error,))
    return job_id


async def scheduler():
    while True:
        try:
            await scheduler_tick()
        except Exception:
            # Continue after transient database/service errors. No secrets or response bodies are logged.
            import logging
            logging.getLogger(__name__).error('Discovery scheduler iteration failed; retrying on the next interval')
        await asyncio.sleep(5)
