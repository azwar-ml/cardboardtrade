import "server-only";
import { db } from "./db";

export type InvFilters = { q?: string; vendor?: string; family?: string; line?: string; choice?: string; status?: string; ply?: string; flute?: string; material?: string; location?: string; minQty?: string; port?: string };

export type InvRow = {
  id: number; ref: string; vendor_id: number; vendor: string; vendor_code: string; upload_id: number; vendor_sku: string | null; line: string; family: string; description: string | null;
  style: string | null; choice: string; defects: string | null; ply: string | null; flute: string | null; board: string | null; gsm: number | null; length_mm: number; width_mm: number; height_mm: number;
  print: string | null; coating: string | null; food_safe: number; qty: number; moq: number | null; price: number; currency: string; price_pkr: number; price_source: string; cbm_per_1000: number;
  kg_per_1000: number; location: string; lead_days: number | null; valid_until: string | null; certifications: string | null; photos: number; status: string; created_at: string; bundle_qty: number | null;
};

export function queryInventory(f: InvFilters, limit = 500) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.q) { where.push("(i.ref LIKE ? OR i.vendor_sku LIKE ? OR i.description LIKE ? OR v.name LIKE ? OR i.line LIKE ?)"); const q = `%${f.q}%`; args.push(q, q, q, q, q); }
  if (f.vendor) { where.push("v.id = ?"); args.push(Number(f.vendor)); }
  if (f.family) { where.push("i.family = ?"); args.push(f.family); }
  if (f.line) { where.push("i.line = ?"); args.push(f.line); }
  if (f.choice) { where.push("i.choice = ?"); args.push(f.choice); }
  if (f.ply) { where.push("i.ply = ?"); args.push(f.ply); }
  if (f.flute) { where.push("i.flute = ?"); args.push(f.flute); }
  if (f.material) { where.push("(i.board LIKE ? OR cast(i.gsm as text) LIKE ? OR i.coating LIKE ?)"); const m = `%${f.material}%`; args.push(m, m, m); }
  if (f.location) { where.push("i.location = ?"); args.push(f.location); }
  if (f.minQty) { where.push("i.qty >= ?"); args.push(Number(f.minQty)); }
  where.push("i.status = ?"); args.push(f.status || "online");
  const sql = `FROM items i JOIN vendors v ON v.id = i.vendor_id WHERE ${where.join(" AND ")}`;
  const rows = db().prepare(`SELECT i.*, v.name vendor, v.code vendor_code ${sql} ORDER BY i.created_at DESC, v.name, i.line, i.length_mm LIMIT ${limit}`).all(...args) as InvRow[];
  const tot = db().prepare(`SELECT count(*) n, coalesce(sum(i.qty),0) pcs, coalesce(sum(i.qty * i.cbm_per_1000 / 1000),0) cbm ${sql}`).get(...args) as { n: number; pcs: number; cbm: number };
  return { rows, total: tot };
}
