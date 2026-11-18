import json
import os
from pathlib import Path
from agents.supplier_discovery.storage import connection, now, database_path


def migrate():
    with connection() as conn:
        conn.executescript(Path(__file__).with_name('schema.sql').read_text())


def files_dir():
    folder = database_path().parent / 'catalog-sources'
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def demo_allowed():
    return os.getenv('CATALOG_ALLOW_DEMO_INPUT') == 'true' and database_path().parent.name.startswith('.qa-')


def dump(value):
    return json.dumps(value, ensure_ascii=False, default=str)


def decode(row):
    result = dict(row)
    for field in ('source', 'raw', 'data', 'errors', 'warnings', 'matches', 'mapping', 'update_fields'):
        if field in result:
            result[field] = json.loads(result[field])
    result.pop('stored_name', None)
    return result


def audit(conn, job, user, action, detail, row=None):
    conn.execute('INSERT INTO catalog_audit(job_id,row_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?,?)',
                 (job, row, user, action, dump(detail), now()))


def refresh_status(conn, job):
    counts = dict(conn.execute('SELECT status,count(*) FROM catalog_rows WHERE job_id=? GROUP BY status', (job,)))
    remaining = sum(counts.get(s, 0) for s in ('Needs Review', 'Correction Requested'))
    approved = counts.get('Approved', 0) + counts.get('Published', 0)
    status = 'Partially Approved' if approved and (remaining or counts.get('Approved')) else 'Needs Review' if remaining or not counts else 'Completed'
    conn.execute('UPDATE catalog_jobs SET status=?,stage=?,updated_at=? WHERE id=? AND status NOT IN (\'Cancelled\',\'Failed\')',
                 (status, status, now(), job))
