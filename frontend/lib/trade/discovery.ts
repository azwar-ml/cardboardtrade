import "server-only";
import type Database from "better-sqlite3";

const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
type Enquiry = { id: string; receivedAt: string; subject: string; company: string; email: string; phone: string; country: string; city?: string; product: string; message: string; attachments: string[] };

/** Called inside the original enquiry transaction: both records commit, or neither does. */
export function linkSellerSubmission(d: Database.Database, record: Enquiry) {
  if (record.subject !== "Selling request") return;
  if (d.prepare("SELECT 1 FROM discovery_sources WHERE enquiry_id=?").get(record.id)) return;
  const matches: { kind: string; id: number; name: string; reasons: string[] }[] = [];
  for (const [table, field, kind] of [["discovery_leads", "company", "lead"], ["vendors", "name", "vendor"]]) {
    const rows = d.prepare(`SELECT id,${field} name,email FROM ${table}`).all() as { id: number; name: string; email: string | null }[];
    for (const row of rows) {
      const reasons = [];
      if (key(row.name) === key(record.company)) reasons.push("company name");
      if (row.email?.trim().toLowerCase() === record.email.trim().toLowerCase()) reasons.push("business email");
      if (reasons.length) matches.push({ kind, id: row.id, name: row.name, reasons });
    }
  }
  const match = matches.find((m) => m.kind === "lead");
  const stamp = new Date().toISOString();
  const leadId = match?.id ?? Number(d.prepare(`INSERT INTO discovery_leads(company,name_key,country,city,products,email,phone,source_type,duplicate_matches,discovered_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'Website Submission',?,?,?)`).run(record.company, key(record.company), record.country, record.city || "",
      JSON.stringify(record.product ? [record.product] : []), record.email, record.phone, JSON.stringify(matches), stamp, stamp).lastInsertRowid);
  d.prepare("UPDATE discovery_leads SET updated_at=? WHERE id=?").run(stamp, leadId);
  if (record.city) d.prepare("UPDATE discovery_leads SET city=? WHERE id=? AND city='' AND status='Pending Review'").run(record.city, leadId);
  d.prepare(`INSERT INTO discovery_sources(lead_id,source_key,source_type,enquiry_id,evidence,accessed_at)
    VALUES(?,?,'Website Submission',?,?,?)`).run(leadId, `enquiry:${record.id}`, record.id, JSON.stringify(record), stamp);
  d.prepare("INSERT INTO discovery_activity(lead_id,actor,action,detail,at) VALUES(?,'website',?,?,?)")
    .run(leadId, matches.length ? "Duplicate linked" : "Lead created", record.id, stamp);
}
