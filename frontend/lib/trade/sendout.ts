import "server-only";
import { db, json } from "./db";
import { matchBuyers, type Match } from "./match";
import { buildAttachment, composeFor, deliver, DEFAULT_BODY, DEFAULT_OPTIONS, DEFAULT_SUBJECT, isoWeek, itemsForOptions, optionsOf } from "./mail";

export type Sendout = { id: number; name: string | null; status: string; upload_ids: string; excluded_buyer_ids: string; subject: string | null; body: string | null; options: string; sender_id: number | null; created_by: number | null; created_at: string; sent_at: string | null };
export type Message = { id: number; sendout_id: number; buyer_id: number; contact_id: number; score: number; signals: string; item_ids: string; subject: string; body: string; overridden: number; attachment: string | null; status: string; error: string | null; eml_path: string | null; sent_at: string | null; reply_note: string | null };

export const getSendout = (id: number) => db().prepare("SELECT * FROM sendouts WHERE id = ?").get(id) as Sendout | undefined;

export function createDraft(uploadIds: number[], userId: number) {
  const vendors = db().prepare(`SELECT DISTINCT v.name FROM uploads u JOIN vendors v ON v.id = u.vendor_id WHERE u.id IN (${uploadIds.map(() => "?").join(",")})`).all(...uploadIds) as { name: string }[];
  const name = `CW${isoWeek()} · ${vendors.map((v) => v.name).slice(0, 2).join(", ")}${vendors.length > 2 ? ` +${vendors.length - 2}` : ""} · ${uploadIds.length} listing${uploadIds.length > 1 ? "s" : ""}`;
  const r = db().prepare("INSERT INTO sendouts(name, upload_ids, subject, body, options, sender_id, created_by) VALUES (?,?,?,?,?,?,?)")
    .run(name, JSON.stringify(uploadIds), DEFAULT_SUBJECT, DEFAULT_BODY, JSON.stringify(DEFAULT_OPTIONS), userId, userId);
  return Number(r.lastInsertRowid);
}

export function sendoutMatches(s: Sendout): Match[] {
  return matchBuyers(json<number[]>(s.upload_ids, []), { sendoutId: s.id });
}
export function includedMatches(s: Sendout) {
  const ex = new Set(json<number[]>(s.excluded_buyer_ids, []));
  const o = optionsOf(s.options);
  return sendoutMatches(s).filter((m) => !m.excluded && !ex.has(m.buyer.id) && itemsForOptions(m.items, o).length > 0);
}

/** (Re)build one message per included buyer. Messages the user edited by hand are kept unless `force`. */
export function generateMessages(sendoutId: number, force = false) {
  const d = db();
  const s = getSendout(sendoutId)!;
  const sender = d.prepare("SELECT name FROM users WHERE id = ?").get(s.sender_id ?? s.created_by) as { name: string } | undefined;
  const o = optionsOf(s.options);
  const matches = includedMatches(s);
  const keep = new Map((d.prepare("SELECT buyer_id, id FROM sendout_messages WHERE sendout_id = ? AND overridden = 1").all(sendoutId) as { buyer_id: number; id: number }[]).map((r) => [r.buyer_id, r.id]));
  d.transaction(() => {
    d.prepare(`DELETE FROM sendout_messages WHERE sendout_id = ? ${force ? "" : "AND overridden = 0"}`).run(sendoutId);
    if (force) keep.clear();
    const ins = d.prepare("INSERT INTO sendout_messages(sendout_id,buyer_id,contact_id,score,signals,item_ids,subject,body) VALUES (?,?,?,?,?,?,?,?)");
    const upd = d.prepare("UPDATE sendout_messages SET score = ?, signals = ?, item_ids = ? WHERE id = ?");
    const ids = new Set(matches.map((m) => m.buyer.id));
    for (const [buyerId, id] of keep) if (!ids.has(buyerId)) d.prepare("DELETE FROM sendout_messages WHERE id = ?").run(id);
    for (const m of matches) {
      const c = composeFor(m, { subject: s.subject ?? DEFAULT_SUBJECT, body: s.body ?? DEFAULT_BODY }, o, { name: sender?.name ?? "Cardboard Package" });
      const itemIds = JSON.stringify(c.items.map((i) => i.id));
      if (keep.has(m.buyer.id)) upd.run(m.score, JSON.stringify(m.signals), itemIds, keep.get(m.buyer.id));
      else ins.run(sendoutId, m.buyer.id, m.contact!.id, m.score, JSON.stringify(m.signals), itemIds, c.subject, c.body);
    }
  })();
}

export function messages(sendoutId: number) {
  return db().prepare(`SELECT m.*, b.name buyer, b.country, b.port_code, c.name contact, c.email, c.language, c.register, c.bounce, u.initials am
    FROM sendout_messages m JOIN buyers b ON b.id = m.buyer_id JOIN contacts c ON c.id = m.contact_id LEFT JOIN users u ON u.id = b.am_user_id
    WHERE m.sendout_id = ? ORDER BY m.score DESC, b.name`).all(sendoutId) as (Message & { buyer: string; country: string; port_code: string | null; contact: string; email: string; language: string; register: string; bounce: string; am: string | null })[];
}

/** Send every queued message: build the buyer's Excel list, then deliver (SMTP if configured, else the local outbox). */
export async function sendAll(sendoutId: number, userId: number) {
  const d = db();
  const s = getSendout(sendoutId)!;
  const pendingRetries = (d.prepare("SELECT count(*) n FROM sendout_messages WHERE sendout_id = ? AND status = 'failed'").get(sendoutId) as { n: number }).n;
  if (s.status === "sent" && pendingRetries === 0) return { sent: 0, failed: 0 };
  d.prepare("UPDATE sendout_messages SET status = 'queued', error = NULL WHERE sendout_id = ? AND status = 'failed'").run(sendoutId);
  const o = optionsOf(s.options);
  const sender = d.prepare("SELECT name FROM users WHERE id = ?").get(s.sender_id ?? userId) as { name: string };
  const byBuyer = new Map(sendoutMatches(s).map((m) => [m.buyer.id, m]));
  let sent = 0, failed = 0;
  for (const msg of messages(sendoutId)) {
    if (msg.status !== "queued") continue;
    try {
      const m = byBuyer.get(msg.buyer_id);
      if (!m) throw new Error("Buyer no longer matches these listings.");
      if (m.excluded) throw new Error(m.excluded);
      if (!m.contact || m.contact.id !== msg.contact_id || m.contact.bounce !== "none") throw new Error("The selected contact is no longer eligible for email outreach.");
      const ids = new Set(json<number[]>(msg.item_ids, []));
      const items = m.items.filter((i) => ids.has(i.id));
      if (!items.length) throw new Error("No selected listings remain online and valid.");
      const att = o.attachList && items.length ? await buildAttachment(m, items, o, sendoutId) : null;
      const r = await deliver({ to: msg.email, toName: msg.contact, fromName: sender.name, subject: msg.subject, body: msg.body, attachment: att?.path ?? null, sendoutId, messageId: msg.id });
      d.prepare("UPDATE sendout_messages SET status = ?, attachment = ?, eml_path = ?, sent_at = datetime('now'), error = NULL WHERE id = ?").run(r.status, att?.path ?? null, r.eml, msg.id);
      sent++;
    } catch (e) {
      d.prepare("UPDATE sendout_messages SET status = 'failed', error = ? WHERE id = ?").run((e as Error).message, msg.id);
      failed++;
    }
  }
  if (sent > 0) d.prepare("UPDATE sendouts SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(sendoutId);
  return { sent, failed };
}

/** Test send of one message to the signed-in user. Not recorded against the buyer. */
export async function sendTest(sendoutId: number, user: { name: string; email: string }) {
  const s = getSendout(sendoutId)!;
  const msg = messages(sendoutId)[0];
  if (!msg) throw new Error("No messages to test.");
  const m = sendoutMatches(s).find((x) => x.buyer.id === msg.buyer_id)!;
  const ids = new Set(json<number[]>(msg.item_ids, []));
  const o = optionsOf(s.options);
  const att = o.attachList ? await buildAttachment(m, m.items.filter((i) => ids.has(i.id)), o, sendoutId) : null;
  return deliver({ to: user.email, toName: user.name, fromName: user.name, subject: `[TEST] ${msg.subject}`, body: msg.body, attachment: att?.path ?? null, sendoutId, messageId: 0 });
}
