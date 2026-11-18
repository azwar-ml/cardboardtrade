import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import Database from "better-sqlite3";

const dir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass a new, disposable data directory.");
fs.mkdirSync(dir, { recursive: true });
const filename = path.join(dir, "trade.db");
if (fs.existsSync(filename)) throw new Error(`Refusing to overwrite existing QA data: ${filename}`);
const db = new Database(filename);
db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, initials TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','sales')), password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));");
const hash = (password) => { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`; };
db.prepare("INSERT INTO settings(key,value) VALUES('seeded','2')").run();
const insert = db.prepare("INSERT INTO users(name,email,initials,role,password_hash) VALUES(?,?,?,?,?)");
insert.run("QA Admin", "admin@qa.invalid", "QA", "admin", hash("qa-admin-pass"));
insert.run("QA Sales", "sales@qa.invalid", "QS", "sales", hash("qa-sales-pass"));
db.close();
console.log(`Fresh disposable QA database prepared at ${filename}`);
