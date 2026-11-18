"""Safe, additive SQLite schema migration with pre/post row-count verification."""
import argparse
import datetime as dt
import json
import sqlite3
from pathlib import Path


def counts(conn):
    names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {name: conn.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}


def restore(backup: Path, db_path: Path):
    source = sqlite3.connect(backup)
    target = sqlite3.connect(db_path)
    source.backup(target)
    target.close()
    source.close()


def migrate(db_path: Path):
    if not db_path.is_file():
        raise SystemExit(f"Database not found: {db_path}")
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = db_path.with_name(db_path.name + f".pre-migration-{stamp}.bak")
    source = sqlite3.connect(db_path)
    snapshot = sqlite3.connect(backup)
    source.backup(snapshot)
    snapshot.close()
    before = counts(source)
    source.execute("PRAGMA foreign_keys=ON")
    source.execute("BEGIN IMMEDIATE")
    source.execute("""CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY, received_at TEXT NOT NULL, subject TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT NOT NULL, phone TEXT, company TEXT NOT NULL, country TEXT NOT NULL, product TEXT, quantity TEXT,
      message TEXT NOT NULL, callback INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]'
    )""")
    source.execute("CREATE TABLE IF NOT EXISTS login_attempts (email TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until TEXT)")
    discovery_schema = Path(__file__).parent / 'agents' / 'supplier_discovery' / 'schema.sql'
    for statement in discovery_schema.read_text().split(';'):
        if statement.strip():
            source.execute(statement)
    legacy_path = db_path.parent / "requests.json"
    imported = 0
    if legacy_path.is_file():
        legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
        if not isinstance(legacy, list):
            source.rollback()
            source.close()
            raise ValueError("Legacy requests.json must contain a JSON list; backup was created and no legacy data was removed.")
        insert = """INSERT OR IGNORE INTO enquiries
          (id,received_at,subject,first_name,last_name,email,phone,company,country,product,quantity,message,callback,attachments)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""
        for row in legacy:
            if not isinstance(row, dict) or not row.get("id"):
                source.rollback()
                source.close()
                raise ValueError("Legacy enquiry record has no ID; backup was created and the migration was rolled back.")
            cur = source.execute(insert, (
                str(row["id"]), str(row.get("receivedAt") or ""), row.get("subject"), str(row.get("firstName") or ""),
                str(row.get("lastName") or ""), str(row.get("email") or ""), row.get("phone"), str(row.get("company") or ""),
                str(row.get("country") or ""), row.get("product"), row.get("quantity"), str(row.get("message") or ""),
                1 if row.get("callback") else 0, json.dumps(row.get("attachments") or []),
            ))
            imported += cur.rowcount
    source.commit()
    after = counts(source)
    fk_errors = source.execute("PRAGMA foreign_key_check").fetchall()
    integrity = source.execute("PRAGMA integrity_check").fetchone()[0]
    source.close()
    expected = {k: before[k] + (imported if k == "enquiries" else 0) for k in before}
    if expected != {k: after[k] for k in before} or fk_errors or integrity != "ok":
        restore(backup, db_path)
        raise RuntimeError(f"Migration verification failed. Before={before}; after={after}; fk={fk_errors}; integrity={integrity}")
    result = {"database": str(db_path), "backup": str(backup), "counts_before": before, "counts_after": after, "legacy_enquiries_imported": imported, "counts_preserved": True, "foreign_key_errors": fk_errors, "integrity_check": integrity}
    report = db_path.with_name(db_path.stem + ".migration-counts.json")
    report.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    migrate(parser.parse_args().database)
