import "server-only";
import { db, json } from "./db";
import { lane } from "./pricing";
import { stockRequiresConfirmation } from "./inventory-freshness";

export type Item = {
  id: number; ref: string; vendor_id: number; upload_id: number; line: string; family: string; description: string | null; style: string | null; choice: string;
  defects: string | null; ply: string | null; flute: string | null; board: string | null; gsm: number | null; length_mm: number; width_mm: number; height_mm: number;
  print: string | null; coating: string | null; food_safe: number; qty: number; moq: number | null; price_pkr: number; cbm_per_1000: number; kg_per_1000: number;
  location: string; lead_days: number | null; status: string; certifications: string | null; photos: number;
};
export type Buyer = { id: number; name: string; country: string; city: string | null; port_code: string | null; industry: string | null; interests: string; choice_pref: string; min_order_pcs: number | null; incoterm: string; language: string; am_user_id: number | null; status: string; blocked_reason: string | null };
export type Contact = { id: number; buyer_id: number; name: string; title: string | null; email: string; language: string; register: string; bounce: string };
export type Signal = { label: string; points: number; tone: "good" | "info" | "warn" };
export type Match = {
  buyer: Buyer; am: string | null; contact: Contact | null; score: number; signals: Signal[]; items: Item[]; pcs: number; transit: number | null; port: string | null;
  excluded: string | null; lastSent: string | null;
};

export const CAP_DAYS = 7;

export function listingItems(uploadIds: number[]): Item[] {
  if (!uploadIds.length) return [];
  return db().prepare(`SELECT i.* FROM items i JOIN vendors v ON v.id = i.vendor_id WHERE i.status = 'online' AND v.status != 'blocked'
    AND (i.valid_until IS NULL OR i.valid_until = '' OR i.valid_until >= date('now'))
    AND i.upload_id IN (${uploadIds.map(() => "?").join(",")}) ORDER BY i.line, i.length_mm`).all(...uploadIds).filter(row => !stockRequiresConfirmation((row as Item).id)) as Item[];
}

export function matchBuyers(uploadIds: number[], opts: { sendoutId?: number } = {}): Match[] {
  const d = db();
  const items = listingItems(uploadIds);
  const buyers = d.prepare("SELECT * FROM buyers ORDER BY name").all() as Buyer[];
  const users = new Map((d.prepare("SELECT id, initials FROM users").all() as { id: number; initials: string }[]).map((u) => [u.id, u.initials]));
  const events = d.prepare("SELECT buyer_id, kind, line, at FROM buyer_events WHERE at >= date('now','-24 months')").all() as { buyer_id: number; kind: string; line: string; at: string }[];
  const lastSent = new Map((d.prepare(`SELECT m.buyer_id, max(m.sent_at) at FROM sendout_messages m JOIN sendouts s ON s.id = m.sendout_id
    WHERE m.status IN ('sent','outbox','replied') AND (? IS NULL OR s.id != ?) GROUP BY m.buyer_id`).all(opts.sendoutId ?? null, opts.sendoutId ?? null) as { buyer_id: number; at: string }[]).map((r) => [r.buyer_id, r.at]));
  const contacts = d.prepare("SELECT * FROM contacts ORDER BY primary_contact DESC, id").all() as Contact[];
  const capMs = CAP_DAYS * 864e5;
  const out: Match[] = [];

  for (const b of buyers) {
    const interests = json<string[]>(b.interests, []);
    const ev = events.filter((e) => e.buyer_id === b.id);
    const bought = new Set(ev.filter((e) => e.kind === "purchase").map((e) => e.line));
    const rfq = new Set(ev.filter((e) => e.kind === "rfq").map((e) => e.line));
    const wanted = new Set([...interests, ...bought, ...rfq]);
    const fit = items.filter((it) => wanted.has(it.line) && (b.choice_pref === "mixed" || b.choice_pref === it.choice) && (!b.min_order_pcs || it.qty >= b.min_order_pcs));
    if (!fit.length) continue;

    const lines = new Set(fit.map((i) => i.line));
    const signals: Signal[] = [];
    const hit = (set: Set<string>) => [...lines].filter((l) => set.has(l));
    if (hit(bought).length) signals.push({ label: `Bought ${hit(bought).join(", ")}`, points: 35, tone: "good" });
    if (hit(rfq).length) signals.push({ label: `Past RFQ: ${hit(rfq).join(", ")}`, points: 25, tone: "good" });
    if (hit(new Set(interests)).length) signals.push({ label: "Preference", points: 15, tone: "info" });
    const choices = new Set(fit.map((i) => i.choice));
    if (b.choice_pref !== "mixed" && choices.size === 1) signals.push({ label: `${b.choice_pref} choice buyer`, points: 10, tone: "info" });
    const l = lane(b.port_code);
    if (l) signals.push({ label: `${l.port} · ${l.transit_days}d`, points: 10, tone: "info" });
    else signals.push({ label: "No freight lane", points: 0, tone: "warn" });
    const coverage = Math.round(Math.min(15, (fit.length / Math.max(1, items.length)) * 15));
    const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0) + coverage + 5);

    const contact = contacts.find((c) => c.buyer_id === b.id && c.bounce === "none") ?? null;
    const ls = lastSent.get(b.id) ?? null;
    let excluded: string | null = null;
    if (b.status === "blocked") excluded = `Blocked: ${b.blocked_reason ?? "no reason recorded"}`;
    else if (!contact) excluded = "No non-bounced email contact. Update the contact before sending.";
    else if (ls && Date.now() - new Date(ls + "Z").getTime() < capMs) excluded = `Sent ${ls.slice(0, 10)} — inside the ${CAP_DAYS}-day cap`;
    if (contact?.bounce === "soft") signals.push({ label: "Soft bounce", points: 0, tone: "warn" });

    out.push({ buyer: b, am: b.am_user_id ? users.get(b.am_user_id) ?? null : null, contact, score, signals, items: fit, pcs: fit.reduce((s, i) => s + i.qty, 0), transit: l?.transit_days ?? null, port: l ? `${l.port}, ${l.country}` : null, excluded, lastSent: ls });
  }
  return out.sort((a, b) => (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) || b.score - a.score);
}
