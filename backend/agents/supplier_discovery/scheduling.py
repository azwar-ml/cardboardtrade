import datetime as dt
import json
import os
from .storage import connection, now
from .providers import configuration, usage_status

AUTOMATION_INTERVAL = 48 * 60 * 60
ROTATION = [
    {'product': 'corrugated', 'city': 'Lahore', 'keywords': 'packaging'},
    {'product': 'cardboard', 'city': 'Karachi', 'keywords': 'manufacturer'},
    {'product': 'carton', 'city': '', 'keywords': 'printed'},
    {'product': 'flexible packaging', 'city': 'Lahore', 'keywords': 'factory'},
    {'product': 'paper bags', 'city': 'Karachi', 'keywords': 'packaging'},
    {'product': 'corrugated', 'city': 'Faisalabad', 'keywords': 'manufacturer'},
    {'product': 'carton', 'city': 'Gujranwala', 'keywords': 'packaging'},
    {'product': 'packaging', 'city': 'Sialkot', 'keywords': 'factory'},
    {'product': 'cardboard', 'city': 'Multan', 'keywords': 'manufacturer'},
    {'product': 'folding', 'city': '', 'keywords': 'packaging'},
    {'product': 'packaging', 'city': 'Islamabad', 'keywords': 'manufacturer'},
    {'product': 'corrugated', 'city': 'Rawalpindi', 'keywords': 'factory'},
]


def rotating_criteria(filters):
    cursor = int(filters.get('_rotation_cursor', 0)) % len(ROTATION)
    return {**ROTATION[cursor], 'mode': 'automatic', 'rotation_enabled': True, 'rotation_index': cursor, 'scheduled': True}


def future(seconds):
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=seconds)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def research_mode(filters, config=None):
    config = config or configuration()
    return filters.get('mode') or ('automatic' if config['automatic_ready'] else 'seeds')


def default_schedule():
    return {'enabled': int(os.getenv('DISCOVERY_SCHEDULE_SECONDS', '0')) > 0,
            'interval_seconds': max(60, int(os.getenv('DISCOVERY_SCHEDULE_SECONDS', str(AUTOMATION_INTERVAL))) or AUTOMATION_INTERVAL),
            'filters': {k: os.getenv('DISCOVERY_SCHEDULE_' + k.upper(), '')[:200] for k in ('product', 'city', 'keywords')}}


def ensure_schedule(conn):
    config = default_schedule()
    conn.execute('''INSERT OR IGNORE INTO discovery_schedule(id,enabled,interval_seconds,filters,next_run_at,updated_at,updated_by)
      VALUES(1,?,?,?,?,?,'environment')''', (int(config['enabled']), config['interval_seconds'], json.dumps(config['filters']),
                                           future(config['interval_seconds']) if config['enabled'] else None, now()))


def schedule_status():
    with connection() as conn:
        ensure_schedule(conn)
        result = dict(conn.execute('SELECT * FROM discovery_schedule WHERE id=1').fetchone())
        active = conn.execute("SELECT id FROM discovery_jobs WHERE status IN ('Queued','Running') LIMIT 1").fetchone()
        last = conn.execute('SELECT id,status,finished_at,error FROM discovery_jobs WHERE trigger_type=\'Scheduled\' ORDER BY id DESC LIMIT 1').fetchone()
    config = configuration()
    result['filters'] = json.loads(result['filters'])
    mode = research_mode(result['filters'], config)
    blocked = None
    if result['enabled']:
        if mode == 'automatic' and not config['automatic_ready']:
            blocked = ' '.join(config['setup_errors']) or 'Search provider not configured.'
        elif mode == 'seeds' and not config['seed_urls']:
            blocked = 'Recurring seed research requires configured permitted seed URLs.'
        elif mode == 'automatic':
            blocked = usage_status()['paused_reason']
    result['enabled'] = bool(result['enabled'])
    result['status'] = 'Disabled' if not result['enabled'] else 'Blocked' if blocked else 'Waiting for active job' if active else 'Scheduled'
    result['blocked_reason'] = blocked
    result['last_job'] = dict(last) if last else None
    result['rotation_enabled'] = bool(result['filters'].get('rotation_enabled'))
    result['next_criteria'] = rotating_criteria(result['filters']) if result['rotation_enabled'] else result['filters']
    result['rotation_count'] = len(ROTATION)
    result['recheck_days'] = 7
    return result


def save_schedule(payload, actor):
    with connection() as conn:
        ensure_schedule(conn)
        filters = dict(payload['filters'])
        if filters.get('rotation_enabled'):
            previous = json.loads(conn.execute('SELECT filters FROM discovery_schedule WHERE id=1').fetchone()[0])
            filters['_rotation_cursor'] = previous.get('_rotation_cursor', 0)
            filters['mode'] = 'automatic'
            payload = {**payload, 'interval_seconds': AUTOMATION_INTERVAL}
        conn.execute('''UPDATE discovery_schedule SET enabled=?,interval_seconds=?,filters=?,next_run_at=?,last_error=NULL,
          updated_by=?,updated_at=? WHERE id=1''', (int(payload['enabled']), payload['interval_seconds'], json.dumps(filters),
                                                   future(payload['interval_seconds']) if payload['enabled'] else None, actor, now()))
    return schedule_status()
