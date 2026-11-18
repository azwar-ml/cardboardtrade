import "server-only";
import { db, json } from "./db";

export type CatalogOffer = { id: number; vendor_id: number; supplier: string; data: Record<string,string | number | null>; source: Record<string,string | number>; updated_at: string };
export function queryCatalogInventory(filters: { q?: string; vendor?: string; product?: string; page?: string }) {
  const d = db();
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_products'").get()) return { rows: [] as CatalogOffer[], total: 0, page: 1 };
  const terms: string[] = [], values: (string | number)[] = [];
  if (filters.vendor) { terms.push("p.vendor_id=?"); values.push(filters.vendor); }
  if (filters.product) { terms.push("p.id=?"); values.push(filters.product); }
  if (filters.q) { terms.push("(p.data LIKE ? OR v.name LIKE ?)"); values.push(`%${filters.q.slice(0,200)}%`, `%${filters.q.slice(0,200)}%`); }
  const clause = terms.length ? ` WHERE ${terms.join(" AND ")}` : "";
  const page = Math.max(1, Math.min(100000, Number(filters.page) || 1));
  const total = (d.prepare(`SELECT count(*) n FROM catalog_products p JOIN vendors v ON v.id=p.vendor_id${clause}`).get(...values) as { n: number }).n;
  const raw = d.prepare(`SELECT p.*,v.name supplier FROM catalog_products p JOIN vendors v ON v.id=p.vendor_id${clause} ORDER BY v.name,p.id DESC LIMIT 30 OFFSET ?`).all(...values,(page-1)*30) as (Omit<CatalogOffer,"data"|"source"> & { data: string; source: string })[];
  return { total, page, rows: raw.map(r => ({ ...r, data: json<Record<string,string | number | null>>(r.data,{}), source: json<Record<string,string | number>>(r.source,{}) })) };
}
