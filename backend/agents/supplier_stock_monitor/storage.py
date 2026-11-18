import json
from pathlib import Path
from agents.supplier_discovery.storage import connection, now, database_path
from .models import Settings


def dump(value): return json.dumps(value,ensure_ascii=False,default=str,sort_keys=True)


def migrate():
    with connection() as conn:
        conn.executescript(Path(__file__).with_name('schema.sql').read_text())
        if 'source_at' not in {r[1] for r in conn.execute('PRAGMA table_info(stock_messages)')}:
            conn.execute('ALTER TABLE stock_messages ADD COLUMN source_at TEXT')
        if 'response_due_at' not in {r[1] for r in conn.execute('PRAGMA table_info(stock_requests)')}:
            conn.execute('ALTER TABLE stock_requests ADD COLUMN response_due_at TEXT')
        conn.execute('INSERT OR IGNORE INTO stock_settings VALUES(1,?)',(Settings().model_dump_json(),))
        from .domain import install_view
        install_view(conn)


def settings(conn=None):
    if conn is None:
        with connection() as c: return settings(c)
    return Settings.model_validate_json(conn.execute('SELECT payload FROM stock_settings WHERE id=1').fetchone()[0])


def audit(conn,actor,action,detail=None,request=None,message=None,proposal=None):
    conn.execute('INSERT INTO stock_audit(actor,action,request_id,message_id,proposal_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',
                 (actor,action,request,message,proposal,dump(detail or {}),now()))


def folder(kind):
    p=database_path().parent/('outbox/stock-monitor' if kind=='outbox' else 'stock-attachments')
    p.mkdir(parents=True,exist_ok=True)
    return p


def required(conn,table,identity):
    row=conn.execute('SELECT * FROM '+table+' WHERE id=?',(identity,)).fetchone()
    if not row: raise ValueError('Record not found')
    return dict(row)


def decoded(row):
    result=dict(row)
    for f in ('watch_ids','details','before_data','proposed','evidence','warnings','errors','changes','approved_fields','payload'):
        if f in result: result[f]=json.loads(result[f])
    for f in ('stored_name','outbox_file','baseline','source_hash'):
        result.pop(f,None)
    return result
