import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Resolve relative overrides against the frontend application in both runtimes.
const FRONTEND_DIR = fs.existsSync(path.join(process.cwd(), "frontend/package.json")) ? path.join(process.cwd(), "frontend") : process.cwd();
export const DATA_DIR = path.resolve(FRONTEND_DIR, process.env.TRADE_DATA_DIR || "data");
export const FILES_DIR = path.join(DATA_DIR, "files");
export const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
for (const d of [DATA_DIR, FILES_DIR, OUTBOX_DIR]) fs.mkdirSync(d, { recursive: true });

const g = globalThis as unknown as { __tradeDb?: Database.Database };

export function db() {
  if (g.__tradeDb) return g.__tradeDb;
  const d = new Database(path.join(DATA_DIR, "trade.db"));
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  const needsDiscovery = !d.prepare("SELECT 1 FROM sqlite_master WHERE name='discovery_leads'").get();
  if (needsDiscovery) {
    const backup = path.join(DATA_DIR, `trade.db.pre-discovery-${Date.now()}.bak`);
    d.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  }
  d.exec(SCHEMA);
  if (needsDiscovery) {
    const schema = fs.readFileSync(path.resolve(FRONTEND_DIR, "../backend/agents/supplier_discovery/schema.sql"), "utf8");
    d.transaction(() => d.exec(schema))();
  }
  g.__tradeDb = d;
  return d;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, initials TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','sales')), password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (email TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until TEXT);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enquiries (
  id TEXT PRIMARY KEY, received_at TEXT NOT NULL, subject TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  email TEXT NOT NULL, phone TEXT, company TEXT NOT NULL, country TEXT NOT NULL, product TEXT, quantity TEXT,
  message TEXT NOT NULL, callback INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS freight_lanes (
  code TEXT PRIMARY KEY, port TEXT NOT NULL, country TEXT NOT NULL, region TEXT NOT NULL,
  rate_40hc_usd REAL NOT NULL, transit_days INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS origins (city TEXT PRIMARY KEY, inland_usd_per_cbm REAL NOT NULL);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, legal_name TEXT, city TEXT, address TEXT,
  website TEXT, email TEXT, phone TEXT, business_type TEXT, product_lines TEXT NOT NULL DEFAULT '[]',
  evidence TEXT, export_evidence TEXT, certifications TEXT, sources TEXT NOT NULL DEFAULT '[]', confidence TEXT,
  status TEXT NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','onboarding','active','blocked')),
  am_user_id INTEGER REFERENCES users(id), notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id), status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','checked','failed','published','superseded')),
  raw_files TEXT NOT NULL DEFAULT '[]', transformed_file TEXT, transformed_sha TEXT,
  rows_total INTEGER NOT NULL DEFAULT 0, rows_ok INTEGER NOT NULL DEFAULT 0, rows_error INTEGER NOT NULL DEFAULT 0,
  issues TEXT NOT NULL DEFAULT '[]', parsed TEXT NOT NULL DEFAULT '[]', note TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), checked_at TEXT, published_at TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, vendor_id INTEGER NOT NULL REFERENCES vendors(id), upload_id INTEGER REFERENCES uploads(id),
  vendor_sku TEXT, line TEXT NOT NULL, family TEXT NOT NULL, description TEXT, style TEXT, choice TEXT NOT NULL, defects TEXT,
  ply TEXT, flute TEXT, board TEXT, gsm REAL, length_mm REAL, width_mm REAL, height_mm REAL, dim_type TEXT,
  print TEXT, coating TEXT, food_safe INTEGER NOT NULL DEFAULT 0, qty INTEGER NOT NULL, moq INTEGER,
  price REAL NOT NULL, currency TEXT NOT NULL, price_pkr REAL NOT NULL, price_source TEXT NOT NULL DEFAULT 'vendor',
  bundle_qty INTEGER, bundle_l_cm REAL, bundle_w_cm REAL, bundle_h_cm REAL, bundle_kg REAL, unit_g REAL,
  cbm_per_1000 REAL NOT NULL, kg_per_1000 REAL NOT NULL, location TEXT NOT NULL, lead_days INTEGER,
  available_from TEXT, valid_until TEXT, certifications TEXT, photos INTEGER NOT NULL DEFAULT 0, notes TEXT,
  status TEXT NOT NULL DEFAULT 'online', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS items_vendor ON items(vendor_id);
CREATE INDEX IF NOT EXISTS items_upload ON items(upload_id);

CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, city TEXT, port_code TEXT REFERENCES freight_lanes(code),
  industry TEXT, interests TEXT NOT NULL DEFAULT '[]', choice_pref TEXT NOT NULL DEFAULT 'mixed' CHECK (choice_pref IN ('1st','2nd','mixed')),
  min_order_pcs INTEGER, incoterm TEXT NOT NULL DEFAULT 'CFR', language TEXT NOT NULL DEFAULT 'EN', am_user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','prospect','blocked')), blocked_reason TEXT, is_demo INTEGER NOT NULL DEFAULT 1,
  notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE, name TEXT NOT NULL, title TEXT,
  email TEXT NOT NULL, phone TEXT, language TEXT NOT NULL DEFAULT 'EN', register TEXT NOT NULL DEFAULT 'Formal',
  bounce TEXT NOT NULL DEFAULT 'none' CHECK (bounce IN ('none','soft','hard')), primary_contact INTEGER NOT NULL DEFAULT 1
);
-- buyer history: purchases and RFQs feed the "Bought this" / "Past RFQ" signals
CREATE TABLE IF NOT EXISTS buyer_events (
  id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('purchase','rfq')),
  line TEXT NOT NULL, qty INTEGER, value_usd REAL, at TEXT NOT NULL, note TEXT
);

CREATE TABLE IF NOT EXISTS sendouts (
  id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  upload_ids TEXT NOT NULL DEFAULT '[]', excluded_buyer_ids TEXT NOT NULL DEFAULT '[]', subject TEXT, body TEXT,
  options TEXT NOT NULL DEFAULT '{}', sender_id INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
);
CREATE TABLE IF NOT EXISTS sendout_messages (
  id INTEGER PRIMARY KEY, sendout_id INTEGER NOT NULL REFERENCES sendouts(id) ON DELETE CASCADE, buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id), score INTEGER, signals TEXT, item_ids TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL, body TEXT NOT NULL, overridden INTEGER NOT NULL DEFAULT 0, attachment TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','outbox','failed','replied')), error TEXT, eml_path TEXT,
  sent_at TEXT, reply_note TEXT
);
`;

export const json = <T,>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

export function getSetting(key: string, fallback: string) {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? fallback;
}
export function setSetting(key: string, value: string) {
  db().prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
