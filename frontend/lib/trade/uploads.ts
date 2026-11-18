import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { db, FILES_DIR, json } from "./db";
import { checkRows, readTabular, type Issue, type Row } from "./template";
import { familyOf } from "./catalog";
import { pricingSettings, volumeOf } from "./pricing";

export type StoredFile = { name: string; path: string; sha256: string; size: number; type: string };

export function storeFile(buf: Buffer, name: string, type = "application/octet-stream"): StoredFile {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const safe = path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(-120);
  const rel = path.join(new Date().toISOString().slice(0, 7), `${sha256.slice(0, 12)}-${safe}`);
  const abs = path.join(FILES_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return { name: safe, path: rel, sha256, size: buf.length, type };
}
export const fileAbs = (rel: string) => path.join(FILES_DIR, rel);

/** Create an upload, store its files and run the contract check straight away (Uploaded → Checked / Failed). */
export async function createUpload(input: { vendorId: number; raw: StoredFile[]; transformed: StoredFile; userId: number | null; note?: string }) {
  const r = db().prepare("INSERT INTO uploads(vendor_id, raw_files, transformed_file, transformed_sha, created_by, note) VALUES (?,?,?,?,?,?)")
    .run(input.vendorId, JSON.stringify(input.raw), input.transformed.path, input.transformed.sha256, input.userId, input.note ?? null);
  const id = Number(r.lastInsertRowid);
  await runCheck(id);
  return id;
}

export async function runCheck(uploadId: number) {
  const u = db().prepare("SELECT * FROM uploads WHERE id = ?").get(uploadId) as { transformed_file: string } | undefined;
  if (!u) throw new Error("Upload not found");
  let issues: Issue[] = [], rows: Row[] = [], okIdx: number[] = [], total = 0;
  try {
    const buf = fs.readFileSync(fileAbs(u.transformed_file));
    const t = await readTabular(buf, u.transformed_file);
    if (!t.headers.length) issues = [{ row: 0, column: "—", level: "error", message: "No header row with “Supplier SKU” found. Use the Cardboard Package template." }];
    else if (!t.rows.length) issues = [{ row: 0, column: "—", level: "error", message: "The file has no stock rows (the template's EXAMPLE row is ignored)." }];
    else { const c = checkRows(t.headers, t.rows); issues = c.issues; rows = c.rows; okIdx = c.okIdx; total = t.rows.length; }
  } catch (e) {
    issues = [{ row: 0, column: "—", level: "error", message: `Could not read the file: ${(e as Error).message}` }];
  }
  const ok = rows.length ? okIdx.length : 0;
  const status = ok > 0 ? "checked" : "failed";
  db().prepare("UPDATE uploads SET status = ?, rows_total = ?, rows_ok = ?, rows_error = ?, issues = ?, parsed = ?, checked_at = datetime('now') WHERE id = ?")
    .run(status, total, ok, total - ok, JSON.stringify(issues), JSON.stringify(rows.map((r, i) => ({ ...r, _ok: okIdx.includes(i) }))), uploadId);
}

/** Publish the rows that passed the check into the virtual inventory. Optionally retire the vendor's previous online stock. */
export function publishUpload(uploadId: number, opts: { replacePrevious: boolean; priceSource?: string; keepVendorStatus?: boolean }) {
  const d = db();
  const u = d.prepare("SELECT * FROM uploads WHERE id = ?").get(uploadId) as { id: number; vendor_id: number; status: string; parsed: string } | undefined;
  if (!u || u.status !== "checked") throw new Error("Only checked uploads can be published.");
  const vendor = d.prepare("SELECT status FROM vendors WHERE id = ?").get(u.vendor_id) as { status: string } | undefined;
  if (!vendor || vendor.status === "blocked") throw new Error("Stock from a blocked or missing supplier cannot be published.");
  const rows = json<(Row & { _ok: boolean })[]>(u.parsed, []).filter((r) => r._ok);
  const fx = pricingSettings().fxPkrPerUsd;
  const day = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const insert = d.prepare(`INSERT INTO items (ref, vendor_id, upload_id, vendor_sku, line, family, description, style, choice, defects, ply, flute, board, gsm,
    length_mm, width_mm, height_mm, dim_type, print, coating, food_safe, qty, moq, price, currency, price_pkr, price_source, bundle_qty, bundle_l_cm, bundle_w_cm,
    bundle_h_cm, bundle_kg, cbm_per_1000, kg_per_1000, location, lead_days, valid_until, certifications, photos, notes, status)
    VALUES (@ref,@vendor_id,@upload_id,@vendor_sku,@line,@family,@description,@style,@choice,@defects,@ply,@flute,@board,@gsm,@length_mm,@width_mm,@height_mm,
    @dim_type,@print,@coating,@food_safe,@qty,@moq,@price,@currency,@price_pkr,@price_source,@bundle_qty,@bundle_l_cm,@bundle_w_cm,@bundle_h_cm,@bundle_kg,
    @cbm_per_1000,@kg_per_1000,@location,@lead_days,@valid_until,@certifications,@photos,@notes,'online')`);
  d.transaction(() => {
    if (opts.replacePrevious) {
      d.prepare("UPDATE items SET status = 'offline' WHERE vendor_id = ? AND status = 'online'").run(u.vendor_id);
      d.prepare("UPDATE uploads SET status = 'superseded' WHERE vendor_id = ? AND status = 'published'").run(u.vendor_id);
    }
    for (const r of rows) {
      const v = volumeOf({ line: String(r.line), ply: r.ply as string, length_mm: Number(r.length_mm), width_mm: Number(r.width_mm), height_mm: Number(r.height_mm), bundle_qty: r.bundle_qty as number, bundle_l_cm: r.bundle_l_cm as number, bundle_w_cm: r.bundle_w_cm as number, bundle_h_cm: r.bundle_h_cm as number, bundle_kg: r.bundle_kg as number, gsm: r.gsm as number });
      insert.run({
        ref: `CPI-${day}-${randomBytes(3).toString("hex").toUpperCase()}`, vendor_id: u.vendor_id, upload_id: u.id,
        vendor_sku: r.vendor_sku, line: r.line, family: familyOf(String(r.line)), description: r.description, style: r.style, choice: r.choice, defects: r.defects,
        ply: r.ply, flute: r.flute, board: r.board, gsm: r.gsm, length_mm: r.length_mm, width_mm: r.width_mm, height_mm: r.height_mm, dim_type: r.dim_type ?? "Internal",
        print: r.print ?? "Plain", coating: r.coating ?? "None", food_safe: r.food_safe ? 1 : 0, qty: r.qty, moq: r.moq, price: r.price, currency: r.currency,
        price_pkr: r.currency === "USD" ? Number(r.price) * fx : Number(r.price), price_source: opts.priceSource ?? "vendor",
        bundle_qty: r.bundle_qty, bundle_l_cm: r.bundle_l_cm, bundle_w_cm: r.bundle_w_cm, bundle_h_cm: r.bundle_h_cm, bundle_kg: r.bundle_kg,
        cbm_per_1000: v.cbmPer1000, kg_per_1000: v.kgPer1000, location: r.location, lead_days: r.lead_days, valid_until: r.valid_until,
        certifications: r.certifications, photos: r.photos ? 1 : 0, notes: r.notes,
      });
    }
    d.prepare("UPDATE uploads SET status = 'published', published_at = datetime('now') WHERE id = ?").run(u.id);
    if (!opts.keepVendorStatus) d.prepare("UPDATE vendors SET status = CASE WHEN status IN ('prospect','onboarding') THEN 'active' ELSE status END WHERE id = ?").run(u.vendor_id);
  })();
  return rows.length;
}
