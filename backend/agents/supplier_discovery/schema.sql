CREATE TABLE IF NOT EXISTS discovery_leads (
 id INTEGER PRIMARY KEY, company TEXT NOT NULL, name_key TEXT NOT NULL,
 website TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
 country TEXT NOT NULL DEFAULT '', products TEXT NOT NULL DEFAULT '[]', email TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Pending Review' CHECK(status IN ('Pending Review','Reviewed','Dismissed','Duplicate')),
 duplicate_matches TEXT NOT NULL DEFAULT '[]', linked_lead_id INTEGER REFERENCES discovery_leads(id),
 linked_vendor_id INTEGER REFERENCES vendors(id), discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discovery_name ON discovery_leads(name_key);
CREATE INDEX IF NOT EXISTS discovery_domain ON discovery_leads(domain);
CREATE TABLE IF NOT EXISTS discovery_jobs (
 id INTEGER PRIMARY KEY, trigger_type TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL,
 stage TEXT NOT NULL, filters TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
 found INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
 failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_single_job ON discovery_jobs((1)) WHERE status IN ('Queued','Running');
CREATE TABLE IF NOT EXISTS discovery_sources (
 id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES discovery_leads(id),
 source_key TEXT NOT NULL UNIQUE, source_type TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
 enquiry_id TEXT UNIQUE REFERENCES enquiries(id), job_id INTEGER REFERENCES discovery_jobs(id),
 evidence TEXT NOT NULL, accessed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_attempts (
 id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES discovery_jobs(id),
 lead_id INTEGER REFERENCES discovery_leads(id), url TEXT NOT NULL, status TEXT NOT NULL,
 detail TEXT NOT NULL, accessed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_activity (
 id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES discovery_leads(id), job_id INTEGER REFERENCES discovery_jobs(id),
 actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_search_results (
 id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES discovery_jobs(id), provider TEXT NOT NULL,
 query TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, snippet TEXT NOT NULL,
 disposition TEXT NOT NULL, accessed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_schedule (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, interval_seconds INTEGER NOT NULL,
 filters TEXT NOT NULL DEFAULT '{}', next_run_at TEXT, last_job_id INTEGER REFERENCES discovery_jobs(id),
 last_error TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_provider_check (
 id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, status TEXT NOT NULL,
 checked_at TEXT NOT NULL, error TEXT, result_count INTEGER NOT NULL DEFAULT 0
);
