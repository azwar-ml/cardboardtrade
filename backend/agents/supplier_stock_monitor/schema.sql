CREATE TABLE IF NOT EXISTS stock_settings(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_policies(
 vendor_id INTEGER PRIMARY KEY REFERENCES vendors(id), enabled INTEGER NOT NULL DEFAULT 0,
 excluded INTEGER NOT NULL DEFAULT 0, opted_out INTEGER NOT NULL DEFAULT 0,
 fresh_days INTEGER, contact_days INTEGER, template TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_contacts(
 id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), name TEXT NOT NULL,
 email TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, do_not_contact INTEGER NOT NULL DEFAULT 0,
 reference TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(vendor_id,email));
CREATE TABLE IF NOT EXISTS stock_watch(
 id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id),
 item_id INTEGER UNIQUE REFERENCES items(id), catalog_id INTEGER UNIQUE REFERENCES catalog_products(id),
 fresh_days INTEGER, last_confirmed_at TEXT, source_message_id INTEGER REFERENCES stock_messages(id),
 base_version TEXT, details TEXT NOT NULL DEFAULT '{}',
 CHECK((item_id IS NOT NULL)+(catalog_id IS NOT NULL)=1));
CREATE TABLE IF NOT EXISTS stock_requests(
 id TEXT PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), contact_id INTEGER NOT NULL REFERENCES stock_contacts(id),
 watch_ids TEXT NOT NULL, scope TEXT NOT NULL, request_type TEXT NOT NULL, thread_token TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'Draft', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 last_sent_at TEXT, reply_at TEXT, followup_count INTEGER NOT NULL DEFAULT 0, closed_at TEXT, note TEXT,
 next_followup_at TEXT, response_due_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS stock_request_scope ON stock_requests(vendor_id,scope) WHERE status NOT IN ('Closed','Completed','Cancelled','Declined');
CREATE TABLE IF NOT EXISTS stock_messages(
 id INTEGER PRIMARY KEY, request_id TEXT REFERENCES stock_requests(id), vendor_id INTEGER REFERENCES vendors(id),
 contact_id INTEGER REFERENCES stock_contacts(id), direction TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
 subject TEXT NOT NULL, body TEXT NOT NULL, html TEXT, source_id TEXT UNIQUE, reply_to_id TEXT, references_header TEXT,
 status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, approved_by INTEGER REFERENCES users(id), approved_at TEXT,
 followup_number INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT, provider_id TEXT UNIQUE,
 outbox_file TEXT, error TEXT, extraction_status TEXT, source_hash TEXT, source_at TEXT, simulated INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX IF NOT EXISTS stock_followup_once ON stock_messages(request_id,followup_number) WHERE direction='outgoing' AND followup_number>0;
CREATE TABLE IF NOT EXISTS stock_attachments(
 id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES stock_messages(id), name TEXT NOT NULL,
 kind TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, stored_name TEXT,
 status TEXT NOT NULL, error TEXT, scan_status TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(message_id,sha256));
CREATE TABLE IF NOT EXISTS stock_jobs(
 id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE REFERENCES stock_messages(id),
 status TEXT NOT NULL DEFAULT 'Queued', stage TEXT NOT NULL DEFAULT 'Queued', attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_proposals(
 id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES stock_messages(id), watch_id INTEGER REFERENCES stock_watch(id),
 product_ref TEXT NOT NULL, before_data TEXT NOT NULL, proposed TEXT NOT NULL, evidence TEXT NOT NULL,
 warnings TEXT NOT NULL, errors TEXT NOT NULL, changes TEXT NOT NULL, baseline TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Pending', version INTEGER NOT NULL DEFAULT 1,
 reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_note TEXT, approved_fields TEXT NOT NULL DEFAULT '[]',
 UNIQUE(message_id,product_ref));
CREATE TABLE IF NOT EXISTS stock_audit(
 id INTEGER PRIMARY KEY, actor INTEGER REFERENCES users(id), action TEXT NOT NULL,
 request_id TEXT REFERENCES stock_requests(id), message_id INTEGER REFERENCES stock_messages(id),
 proposal_id INTEGER REFERENCES stock_proposals(id), detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS stock_audit_no_update BEFORE UPDATE ON stock_audit BEGIN SELECT RAISE(ABORT,'Stock audit is append only'); END;
CREATE TRIGGER IF NOT EXISTS stock_audit_no_delete BEFORE DELETE ON stock_audit BEGIN SELECT RAISE(ABORT,'Stock audit is append only'); END;
CREATE TABLE IF NOT EXISTS stock_delivery_events(
 id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, payload_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_events(
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, watch_id INTEGER REFERENCES stock_watch(id),
 proposal_id INTEGER UNIQUE REFERENCES stock_proposals(id), created_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_ai_usage(
 id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES stock_jobs(id), model TEXT, key_name TEXT,
 requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 estimated_cost_usd TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_ai_cache(fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stock_messages_thread ON stock_messages(request_id,created_at);
CREATE INDEX IF NOT EXISTS stock_proposals_review ON stock_proposals(status,watch_id);
