import json
from agents.supplier_discovery.storage import connection


def migrate():
    from agents.supplier_discovery.storage import database_path
    import sqlite3
    path = database_path()
    with connection() as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='qualification_jobs'").fetchone():
            backup = path.with_name('trade.db.pre-qualification.bak')
            if not backup.exists():
                with sqlite3.connect(backup) as target:
                    conn.backup(target)
    with connection() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS qualification_jobs (
          id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES discovery_leads(id),
          kind TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, input TEXT NOT NULL,
          fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, error TEXT,
          report TEXT, review_status TEXT NOT NULL DEFAULT 'Pending Admin Review',
          review_note TEXT NOT NULL DEFAULT '', reviewed_by TEXT, reviewed_at TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS qualification_active ON qualification_jobs(COALESCE(lead_id,0),kind)
          WHERE status IN ('Queued','Running');
        CREATE TABLE IF NOT EXISTS qualification_evidence (
          id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES qualification_jobs(id), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS qualification_prices (
          id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES qualification_jobs(id),
          digest TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS qualification_ai_cache (
          digest TEXT PRIMARY KEY, model TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS qualification_ai_usage (
          id INTEGER PRIMARY KEY, job_id INTEGER, purpose TEXT NOT NULL, model TEXT,
          status TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd TEXT,
          error TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS qualification_settings (
          id INTEGER PRIMARY KEY CHECK(id=1), auto_enabled INTEGER NOT NULL DEFAULT 1,
          batch_size INTEGER NOT NULL DEFAULT 2 CHECK(batch_size BETWEEN 1 AND 5));
        INSERT OR IGNORE INTO qualification_settings(id,auto_enabled) VALUES(1,1);
        CREATE TABLE IF NOT EXISTS qualification_ai_controls (
          scope TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
        ''')
        columns = {row[1] for row in conn.execute('PRAGMA table_info(qualification_ai_usage)')}
        for name, definition in (
            ('key_name', 'TEXT'), ('workload', 'TEXT'), ('request_sent', 'INTEGER NOT NULL DEFAULT 0'),
            ('error_code', 'INTEGER'), ('reserved_input_bytes', 'INTEGER NOT NULL DEFAULT 0'),
            ('reserved_output_tokens', 'INTEGER NOT NULL DEFAULT 0'),
        ):
            if name not in columns:
                conn.execute('ALTER TABLE qualification_ai_usage ADD COLUMN ' + name + ' ' + definition)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS qualification_ai_job_workload ON qualification_ai_usage(job_id,workload) WHERE purpose='analysis' AND workload IS NOT NULL")


def decoded(row):
    result = dict(row)
    for field in ('input', 'report'):
        if result.get(field):
            result[field] = json.loads(result[field])
    return result
