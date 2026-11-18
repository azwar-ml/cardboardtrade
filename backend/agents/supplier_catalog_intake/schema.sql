CREATE TABLE IF NOT EXISTS catalog_jobs (
 id TEXT PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), fingerprint TEXT NOT NULL,
 name TEXT NOT NULL, kind TEXT NOT NULL, source_url TEXT, stored_name TEXT, size INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'Queued', stage TEXT NOT NULL DEFAULT 'Queued', error TEXT,
 parsed_count INTEGER NOT NULL DEFAULT 0, warnings TEXT NOT NULL DEFAULT '[]',
 mapping TEXT NOT NULL DEFAULT '{}', use_ai INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(vendor_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS catalog_rows (
 id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES catalog_jobs(id), ordinal INTEGER NOT NULL,
 source TEXT NOT NULL, raw TEXT NOT NULL, data TEXT NOT NULL, errors TEXT NOT NULL DEFAULT '[]',
 warnings TEXT NOT NULL DEFAULT '[]', matches TEXT NOT NULL DEFAULT '[]', identity TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Needs Review', version INTEGER NOT NULL DEFAULT 1,
 target_id INTEGER REFERENCES catalog_products(id), update_fields TEXT NOT NULL DEFAULT '[]',
 published_id INTEGER REFERENCES catalog_products(id), UNIQUE(job_id,ordinal)
);
-- Compatible extension of virtual inventory: commercial unknowns remain JSON null,
-- Decimal values are strings, and catalog claims never become confirmed ready stock.
CREATE TABLE IF NOT EXISTS catalog_products (
 id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), identity TEXT NOT NULL,
 data TEXT NOT NULL, source TEXT NOT NULL, row_id INTEGER NOT NULL REFERENCES catalog_rows(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(vendor_id,identity)
);
CREATE TABLE IF NOT EXISTS catalog_audit (
 id INTEGER PRIMARY KEY, job_id TEXT REFERENCES catalog_jobs(id), row_id INTEGER REFERENCES catalog_rows(id),
 user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_mappings (
 vendor_id INTEGER PRIMARY KEY REFERENCES vendors(id), mapping TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_controls (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0,
 max_rows INTEGER NOT NULL DEFAULT 2000, max_file_mb INTEGER NOT NULL DEFAULT 10);
INSERT OR IGNORE INTO catalog_controls(id) VALUES(1);
CREATE TABLE IF NOT EXISTS catalog_ai_cache (fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_ai_usage (
 id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES catalog_jobs(id), key_name TEXT, model TEXT,
 status TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_review ON catalog_rows(status,job_id);
CREATE INDEX IF NOT EXISTS catalog_products_vendor ON catalog_products(vendor_id);
