import contextlib
import datetime as dt
import json
import os
import re
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit

SCHEMA = Path(__file__).with_name('schema.sql')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def database_path():
    frontend = Path(__file__).resolve().parents[3] / 'frontend'
    directory = Path(os.environ.get('TRADE_DATA_DIR') or frontend / 'data').expanduser()
    if not directory.is_absolute():
        directory = frontend / directory
    return (directory / 'trade.db').resolve()


def database_fingerprint():
    import hashlib
    return hashlib.sha256(str(database_path()).replace('\\', '/').lower().encode()).hexdigest()


@contextlib.contextmanager
def connection():
    conn = sqlite3.connect(database_path(), timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def migrate():
    path = database_path()
    if not path.is_file():
        raise RuntimeError('Initialize the existing frontend database before starting discovery; TRADE_DATA_DIR must match.')
    with connection() as conn:
        required = {'discovery_leads', 'discovery_search_results', 'discovery_schedule', 'discovery_provider_check'}
        existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not required.issubset(existing):
            backup = path.with_name(path.name + '.pre-discovery-' + now().replace(':', '-') + '.bak')
            with sqlite3.connect(backup) as target:
                conn.backup(target)
        conn.execute('BEGIN IMMEDIATE')
        for statement in SCHEMA.read_text().split(';'):
            if statement.strip():
                conn.execute(statement)


def key(value):
    return re.sub('[^a-z0-9]', '', (value or '').lower())


def domain(value):
    try:
        return (urlsplit(value if '://' in value else 'https://' + value).hostname or '').lower().removeprefix('www.')
    except ValueError:
        return ''


def matches(conn, data):
    found = []
    for kind, table, name in [('lead', 'discovery_leads', 'company'), ('vendor', 'vendors', 'name')]:
        for row in conn.execute(f'SELECT * FROM {table}'):
            reasons = []
            if key(row[name]) == key(data['company']):
                reasons.append('company name')
            if data.get('domain') and domain(row['website'] or '') == data['domain']:
                reasons.append('website domain')
            if data.get('email') and (row['email'] or '').strip().lower() == data['email'].strip().lower():
                reasons.append('business email')
            if reasons:
                found.append({'kind': kind, 'id': row['id'], 'name': row[name], 'reasons': reasons})
    return found


def save_lead(conn, data, source_key, source_type, evidence, url='', enquiry_id=None, job_id=None):
    existing = conn.execute('SELECT lead_id FROM discovery_sources WHERE source_key=?', (source_key,)).fetchone()
    if existing:
        conn.execute('UPDATE discovery_sources SET accessed_at=? WHERE source_key=?', (now(), source_key))
        conn.execute('UPDATE discovery_leads SET updated_at=? WHERE id=?', (now(), existing['lead_id']))
        if job_id is not None:
            conn.execute('INSERT INTO discovery_activity(lead_id,job_id,actor,action,detail,at) VALUES(?,?,?,?,?,?)',
                         (existing['lead_id'], job_id, 'discovery', 'Duplicate linked', source_key, now()))
        return existing['lead_id'], True
    data['domain'] = domain(data.get('website', ''))
    duplicates = matches(conn, data)
    lead_match = next((m for m in duplicates if m['kind'] == 'lead'), None)
    vendor_match = next((m for m in duplicates if m['kind'] == 'vendor'), None)
    stamp = now()
    if lead_match:
        lead_id = lead_match['id']
        conn.execute('UPDATE discovery_leads SET updated_at=? WHERE id=?', (stamp, lead_id))
        # Enrich missing fields only; never replace reviewed facts or existing contacts.
        for field in ('website', 'domain', 'city', 'country', 'email', 'phone'):
            if data.get(field):
                conn.execute(f"UPDATE discovery_leads SET {field}=? WHERE id=? AND {field}='' AND status='Pending Review'",
                             (data[field], lead_id))
    else:
        lead_id = conn.execute('''INSERT INTO discovery_leads(company,name_key,website,domain,city,country,products,email,phone,
          source_type,duplicate_matches,discovered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
            data['company'], key(data['company']), data.get('website', ''), data['domain'], data.get('city', ''),
            data.get('country', ''), json.dumps(data.get('products', [])), data.get('email', ''), data.get('phone', ''),
            source_type, json.dumps(duplicates), stamp, stamp)).lastrowid
    if vendor_match:
        conn.execute('UPDATE discovery_leads SET duplicate_matches=? WHERE id=?', (json.dumps(duplicates), lead_id))
    conn.execute('''INSERT INTO discovery_sources(lead_id,source_key,source_type,url,enquiry_id,job_id,evidence,accessed_at)
      VALUES(?,?,?,?,?,?,?,?)''', (lead_id, source_key, source_type, url, enquiry_id, job_id, json.dumps(evidence), stamp))
    conn.execute('INSERT INTO discovery_activity(lead_id,job_id,actor,action,detail,at) VALUES(?,?,?,?,?,?)',
                 (lead_id, job_id, 'discovery', 'Duplicate linked' if duplicates else 'Lead created', source_key, stamp))
    return lead_id, bool(duplicates)


def sync_submissions():
    with connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        rows = conn.execute('''SELECT e.* FROM enquiries e LEFT JOIN discovery_sources s ON s.enquiry_id=e.id
          WHERE e.subject='Selling request' AND s.id IS NULL''').fetchall()
        for row in rows:
            data = {'company': row['company'], 'email': row['email'], 'phone': row['phone'] or '',
                    'country': row['country'], 'products': [row['product']] if row['product'] else []}
            save_lead(conn, data, 'enquiry:' + row['id'], 'Website Submission', dict(row), enquiry_id=row['id'])
