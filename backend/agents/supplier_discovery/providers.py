"""DuckDuckGo organic search through SerpApi only. Credentials never leave the backend."""
import datetime as dt
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import httpx
from dotenv import dotenv_values
from .storage import domain, connection, now

SEARCH_URL = 'https://serpapi.com/search.json'
ACCOUNT_URL = 'https://serpapi.com/account.json'


class RedactCredentials(logging.Filter):
    def filter(self, record):
        record.msg = re.sub(r'(api_key=)[^&\s"\']+', r'\1[REDACTED]', record.getMessage())
        record.args = ()
        return True


logging.getLogger('httpx').addFilter(RedactCredentials())


class SearchError(ValueError):
    pass


class SearchPaused(SearchError):
    pass


def credential():
    return (os.getenv('SERPAPI_API_KEY', '').strip() or
            str(dotenv_values(Path(__file__).resolve().parents[2] / '.env').get('SERPAPI_API_KEY') or '').strip())


def bounded(name, default, low, high):
    try:
        return min(high, max(low, int(os.getenv(name, str(default)))))
    except ValueError:
        return default


def configuration():
    seeds = [u.strip() for u in os.getenv('DISCOVERY_SEED_URLS', '').split(',') if u.strip()][:20]
    hosts = {domain(u) for u in seeds}
    hosts.update(h.strip().lower().removeprefix('www.') for h in os.getenv('DISCOVERY_ALLOWED_DOMAINS', '').split(',') if h.strip())
    policy = os.getenv('DISCOVERY_SOURCE_POLICY', 'allowlist').strip().lower()
    errors = []
    if not credential():
        errors.append('Search provider not configured. Add SERPAPI_API_KEY to backend/.env. Manual and seed research remain available.')
    if policy not in ('public', 'allowlist'):
        errors.append('Choose DISCOVERY_SOURCE_POLICY=public or allowlist.')
    if policy == 'allowlist' and not hosts:
        errors.append('Configure permitted domains, or explicitly select DISCOVERY_SOURCE_POLICY=public.')
    return {'seed_urls': seeds, 'allowed_domains': sorted(hosts), 'search_provider': 'duckduckgo',
            'search_configured': bool(credential()), 'automatic_ready': not errors,
            'source_policy': policy, 'setup_errors': errors,
            'schedule_seconds': bounded('DISCOVERY_SCHEDULE_SECONDS', 0, 0, 2592000),
            'extraction_provider': 'deterministic', 'max_pages': bounded('DISCOVERY_MAX_PAGES', 12, 1, 20),
            'monthly_search_limit': bounded('DISCOVERY_MONTHLY_SEARCH_LIMIT', 20, 0, 250),
            'reserved_searches': bounded('DISCOVERY_RESERVED_SEARCHES', 50, 0, 250),
            'search_cache_seconds': bounded('DISCOVERY_SEARCH_CACHE_SECONDS', 21600, 21600, 604800),
            'recheck_seconds': 604800}


def fingerprint():
    return hashlib.sha256(('duckduckgo:' + credential()).encode()).hexdigest()


def query_for(filters):
    words, seen = [], set()
    for word in ('Pakistan packaging manufacturer ' + ' '.join(str(filters.get(k, '')).strip() for k in ('product', 'city', 'keywords'))).split():
        if word.lower() not in seen:
            words.append(word)
            seen.add(word.lower())
    return ' '.join(words)[:600]


def ledger_key():
    # Stable across calendar months. Only a verified provider billing-cycle change resets usage.
    return 'discovery.duckduckgo.' + fingerprint() + '.budget'


def read_ledger(conn):
    row = conn.execute('SELECT value FROM settings WHERE key=?', (ledger_key(),)).fetchone()
    if row:
        return json.loads(row[0])
    ledger = {'used': 0, 'cache': {}, 'last_account': None, 'cycle_renewal': None}
    # Preserve historical attempt reservations when moving from calendar-based accounting.
    for old in conn.execute('SELECT value FROM settings WHERE key LIKE ?', ('discovery.duckduckgo.' + fingerprint() + '.%',)):
        value = json.loads(old[0])
        ledger['used'] += value.get('used', 0)
        ledger['cache'].update(value.get('cache', {}))
        account = value.get('last_account')
        if account and (not ledger['last_account'] or account.get('checked_at', '') > ledger['last_account'].get('checked_at', '')):
            ledger['last_account'] = account
    ledger['cycle_renewal'] = (ledger['last_account'] or {}).get('plan_renewal_date')
    return ledger


def write_ledger(conn, ledger):
    conn.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                 (ledger_key(), json.dumps(ledger)))


def credit_pause_reason(ledger, config=None):
    config = config or configuration()
    if ledger['used'] >= config['monthly_search_limit']:
        return 'Local monthly DuckDuckGo search budget reached. Automatic research is paused until SerpApi confirms renewal. Manual websites remain available.'
    account = ledger.get('last_account')
    if account:
        if account.get('account_status', '').lower() != 'active':
            return 'SerpApi subscription is not confirmed Active. Check the account before uncached searching.'
        left = min(account['plan_searches_left'], account['total_searches_left'], min(250, account['searches_per_month']) - account['this_month_usage'])
        if left <= config['reserved_searches']:
            return 'SerpApi allowance or reserved searches reached. Automatic research is paused to preserve your credits.'
    return ledger.get('provider_pause_reason')


def observe_account(ledger, account):
    renewal = account.get('plan_renewal_date')
    previous = ledger.get('cycle_renewal')
    # A new provider renewal date after the prior cycle ended is positive evidence;
    # a calendar-month boundary, balance increase or failed account call is not.
    if renewal and previous and renewal > previous and previous <= now()[:10] and account.get('account_status', '').lower() == 'active':
        ledger['used'] = 0
        ledger['cycle_renewal'] = renewal
        ledger['renewal_confirmed_at'] = now()
    elif renewal and not previous:
        ledger['cycle_renewal'] = renewal  # Establish baseline without erasing existing attempts.
    ledger['last_account'] = {**account, 'checked_at': now()}
    ledger.pop('provider_pause_reason', None)


def store_account(account):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        ledger = read_ledger(conn)
        observe_account(ledger, account)
        write_ledger(conn, ledger)
    return ledger


def note_credit_pause(message):
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        ledger = read_ledger(conn)
        ledger['provider_pause_reason'] = message
        write_ledger(conn, ledger)


def usage_status():
    with connection() as conn:
        ledger = read_ledger(conn)
    return {'used': ledger['used'], 'limit': configuration()['monthly_search_limit'], 'reserved': configuration()['reserved_searches'],
            'account': ledger.get('last_account'), 'cache_seconds': configuration()['search_cache_seconds'],
            'cycle_renewal': ledger.get('cycle_renewal'), 'paused_reason': credit_pause_reason(ledger)}


async def safe_get(client, url, params):
    if os.getenv('DISCOVERY_TEST_MODE') == '1' and not isinstance(client._transport, httpx.MockTransport):
        raise SearchError('Live provider HTTP is disabled in QA; use mocked transport.')
    try:
        response = await client.get(url, params=params, headers={'Accept': 'application/json'})
    except httpx.RequestError:
        raise SearchError('SerpApi could not be reached. No automatic retry was made.') from None
    if response.status_code in (401, 403):
        raise SearchError('SerpApi rejected the credentials or subscription. Check the backend key.')
    if response.status_code == 429:
        raise SearchPaused('SerpApi quota, credits or rate limit exhausted. Research is paused; no automatic retry was made.')
    if response.status_code != 200:
        raise SearchError('SerpApi failed (HTTP %s). No automatic retry was made.' % response.status_code)
    if len(response.content) > 2 * 1024 * 1024:
        raise SearchError('SerpApi response exceeded the safe size limit.')
    try:
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise SearchError('SerpApi returned an invalid response; no suppliers were fabricated.') from None
    if payload.get('error'):
        # Never expose arbitrary provider error text: it may include the query-string API key.
        raise SearchError('SerpApi reported an error or exhausted credits. Check the account; no automatic retry was made.')
    return payload


async def check_account(client, token):
    payload = await safe_get(client, ACCOUNT_URL, {'api_key': token})
    try:
        account = {k: int(payload[k]) for k in ('this_month_usage', 'plan_searches_left', 'total_searches_left', 'searches_per_month')}
        if any(v < 0 for v in account.values()):
            raise ValueError()
        status = payload.get('account_status')
        if not isinstance(status, str) or len(status) > 40:
            raise ValueError()
        renewal = payload.get('plan_renewal_date')
        if renewal is not None:
            renewal = dt.date.fromisoformat(renewal).isoformat()
        account.update(account_status=status, plan_renewal_date=renewal)
        return account
    except (KeyError, TypeError, ValueError):
        raise SearchError('Cannot verify SerpApi account allowance. Search blocked to protect your credits.') from None


async def verify_account():
    token = credential()
    if not token:
        raise SearchError('Search provider not configured. Set SERPAPI_API_KEY in backend/.env.')
    async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client:
        account = await check_account(client, token)
    store_account(account)
    return account


async def duckduckgo_search(filters):
    token = credential()
    if not token:
        raise SearchError('Search provider not configured. Set SERPAPI_API_KEY in backend/.env.')
    config = configuration()
    query = query_for(filters)
    digest = hashlib.sha256(re.sub(r'\s+', ' ', query.lower()).encode()).hexdigest()
    with connection() as conn:
        ledger = read_ledger(conn)
        cached = ledger['cache'].get(digest)
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=config['search_cache_seconds'])).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        if cached and cached['at'] > cutoff:
            if 'results' in cached:
                return query, [{**r, 'cached': True} for r in cached['results']]
            raise SearchError('This search was already attempted recently. Wait for the cooldown; automatic repeat charges are blocked.')
    async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client:
        try:
            account = await check_account(client, token)  # Free; required before EVERY uncached search.
        except SearchPaused as exc:
            note_credit_pause(str(exc))
            raise
        observed = store_account(account)
        reason = credit_pause_reason(observed, config)
        if reason:
            raise SearchPaused(reason)
        with connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            ledger = read_ledger(conn)
            cached = ledger['cache'].get(digest)
            if cached and cached['at'] > cutoff:
                if 'results' in cached:
                    return query, [{**r, 'cached': True} for r in cached['results']]
                raise SearchError('This search was already attempted recently. Automatic repeat charges are blocked.')
            reason = credit_pause_reason(ledger, config)
            if reason:
                raise SearchPaused(reason)
            ledger['used'] += 1  # Reserve before request, including timeouts/cancellation; never undercount.
            ledger['last_account'] = {**account, 'checked_at': now()}
            ledger['cache'] = {k: v for k, v in ledger['cache'].items() if v['at'] > cutoff}
            ledger['cache'][digest] = {'at': now()}
            write_ledger(conn, ledger)
        payload = await safe_get(client, SEARCH_URL, {'engine': 'duckduckgo', 'q': query, 'api_key': token,
                                                     'kl': 'pk-en', 'safe': '1', 'm': 50})
    results = payload.get('organic_results', [])
    if not isinstance(results, list) or any(not isinstance(r, dict) for r in results):
        raise SearchError('SerpApi returned invalid organic results; no suppliers were fabricated.')
    results = [{'url': str(r['link'])[:4000], 'title': str(r.get('title', ''))[:500], 'snippet': str(r.get('snippet', ''))[:2000]}
               for r in results[:50] if isinstance(r.get('link'), str) and not r.get('is_ad') and not r.get('sponsored')]
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        ledger = read_ledger(conn)
        ledger['cache'][digest] = {'at': now(), 'results': results}
        write_ledger(conn, ledger)
    return query, results
