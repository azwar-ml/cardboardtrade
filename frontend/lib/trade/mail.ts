import "server-only";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import { db, OUTBOX_DIR, json } from "./db";
import type { Contact, Item, Match } from "./match";
import { pcsPer40, pricingSettings, quote } from "./pricing";
import { storeFile, fileAbs } from "./uploads";

export type SendoutOptions = { includePrice: boolean; attachList: boolean; pickedForYou: boolean; minLotPcs: number | null; incoterm: "CFR" | "FOB" };
export const DEFAULT_OPTIONS: SendoutOptions = { includePrice: true, attachList: true, pickedForYou: true, minLotPcs: null, incoterm: "CFR" };

export const DEFAULT_SUBJECT = "CW{week}: {lines} · export packaging from Pakistan | Cardboard Package";
export const DEFAULT_BODY = `Here is this week's selection of export-ready packaging from Pakistan, matched to what you buy.

- {count} positions, {pcs} pcs in total, collected from {origins}.
- {priceLine}
- 1st choice is produced to spec. 2nd choice may have minor print or colour variance and is sold as is, without certificates.
- Photos of the actual lots are available on request.

Please mark the positions you are interested in and reply with your quantity, or your best offer, in the attached list.`;

export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7);
}

const GREET: Record<string, { formal: (n: string, t?: string | null) => string; informal: (n: string) => string; sign: string }> = {
  EN: { formal: (n, t) => `Dear ${t ? t + " " : ""}${n.split(" ").slice(-1)[0]},`, informal: (n) => `Hi ${n.split(" ")[0]},`, sign: "Kind regards," },
  DE: { formal: (n, t) => `Sehr geehrte${t === "Mr." ? "r Herr" : t === "Ms." ? " Frau" : "/r"} ${n.split(" ").slice(-1)[0]},`, informal: (n) => `Hallo ${n.split(" ")[0]},`, sign: "Mit freundlichen Grüßen," },
  FR: { formal: (n, t) => `${t === "Ms." ? "Chère Madame" : "Cher Monsieur"} ${n.split(" ").slice(-1)[0]},`, informal: (n) => `Bonjour ${n.split(" ")[0]},`, sign: "Bien cordialement," },
  AR: { formal: (n) => `Dear Mr. ${n.split(" ").slice(-1)[0]},`, informal: (n) => `Hi ${n.split(" ")[0]},`, sign: "Best regards," },
};

export const fill = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export function itemsForOptions(items: Item[], o: SendoutOptions) {
  return o.minLotPcs ? items.filter((i) => i.qty >= (o.minLotPcs as number)) : items;
}

/** Subject and body for one buyer, greeting and sign-off in the contact's language and register. */
export function composeFor(m: Match, base: { subject: string; body: string }, o: SendoutOptions, sender: { name: string }) {
  const items = itemsForOptions(m.items, o);
  const lines = [...new Set(items.map((i) => i.line))];
  const origins = [...new Set(items.map((i) => i.location))];
  const port = m.port;
  const priceLine = !o.includePrice ? "Prices on request: send us your best offer per piece in USD."
    : o.incoterm === "CFR" && port ? `Prices are per piece CFR ${port}, in USD, freight included.` : "Prices are per piece FOB Karachi, in USD.";
  const vars = { week: isoWeek(), lines: lines.slice(0, 3).join(", ") + (lines.length > 3 ? " +" + (lines.length - 3) : ""), count: items.length, pcs: items.reduce((s, i) => s + i.qty, 0).toLocaleString("en-US"), origins: origins.join(", "), priceLine, company: m.buyer.name };
  const c = m.contact as Contact;
  const g = GREET[c.language] ?? GREET.EN;
  const greet = c.register === "Informal" ? g.informal(c.name) : g.formal(c.name, (c as Contact & { title?: string }).title);
  const picked = o.pickedForYou ? m.signals.filter((s) => s.tone === "good").map((s) => s.label) : [];
  const pickedLine = picked.length ? `\n\nWe picked these for you because of your history with us (${picked.join("; ").toLowerCase()}).` : "";
  const body = `${greet}\n\n${fill(base.body, vars)}${pickedLine}\n\n${g.sign}\n${sender.name}\nCardboard Package · Lahore, Pakistan`;
  return { subject: fill(base.subject, vars), body, items };
}

/** Per-buyer material list. Never shows vendor names; prices CFR the buyer's port (or FOB) with our margin. */
export function buyerDescription(item: Item) {
  const vendor = db().prepare("SELECT name, legal_name, code FROM vendors WHERE id = ?").get(item.vendor_id) as { name?: string; legal_name?: string | null; code?: string } | undefined;
  const sourcePrice = db().prepare("SELECT price,currency FROM items WHERE id=?").get(item.id) as { price?: number; currency?: string } | undefined;
  let text = (item.description ?? "").replace(/[\r\n\t]+/g, " ").trim();
  for (const secret of [vendor?.name, vendor?.legal_name, vendor?.code, item.ref, (item as Item & { vendor_sku?: string }).vendor_sku].filter((x): x is string => !!x)) {
    if (secret.length < 4 && secret !== vendor?.code) continue;
    text = text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  }
  if (sourcePrice && Number.isFinite(sourcePrice.price)) {
    const amount = Number(sourcePrice.price).toFixed(2).replace(/\.00$/, "");
    text = text.replace(new RegExp(`\\b${amount.replace(".", "\\.")}\\b`, "g"), "");
  }
  return text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "")
    .replace(/\b(?:PKR|Rs\.?|USD|US\$|\$)\s*[\d,.]+\b/gi, "")
    .replace(/\b(?:cost|supplier|factory|vendor)\s*(?:price|cost)?\s*[:=]?\s*[\d,.]+\b/gi, "")
    .replace(/\b(?:internal|supplier|vendor|factory)\s+(?:purchase|buying|source)\s*(?:price|cost)?\b/gi, "")
    .replace(/\b(?:supplier|vendor)\s+(?:code|sku)\b/gi, "")
    .replace(/\s{2,}/g, " ").replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "");
}

export async function buildAttachment(m: Match, items: Item[], o: SendoutOptions, sendoutId: number) {
  const s = pricingSettings();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Material list", { views: [{ state: "frozen", ySplit: 4 }] });
  ws.getCell("A1").value = `Cardboard Package · material list for ${m.buyer.name}`;
  ws.getCell("A1").font = { bold: true, size: 13 };
  ws.getCell("A2").value = !o.includePrice ? "Prices on request — enter your offer per piece (USD) in the last column." : o.incoterm === "CFR" && m.port ? `Prices per piece in USD, CFR ${m.port}. Valid 7 days, subject to availability.` : "Prices per piece in USD, FOB Karachi. Valid 7 days, subject to availability.";
  ws.getCell("A2").font = { size: 9, color: { argb: "FF62666D" } };
  const cols = ["Ref", "Product", "Description", "Style", "Choice", "Notes (2nd choice)", "Ply / flute", "Size L×W×H mm", "Print", "Coating", "Food safe", "Qty available", "MOQ", o.includePrice ? `Price USD/pc ${o.incoterm === "CFR" && m.port ? "CFR" : "FOB"}` : "Price", "Pcs per 40HC", "Ready in (days)", "Your qty", "Your offer USD/pc"];
  const head = ws.getRow(4); head.values = cols; head.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E1013" } }; c.alignment = { wrapText: true, vertical: "middle" }; });
  head.height = 30;
  for (const it of items) {
    const q = quote(it, m.buyer.port_code, s);
    const price = !o.includePrice ? "Make best offer" : o.incoterm === "CFR" && q.offerCfr != null ? Number(q.offerCfr.toFixed(3)) : Number(q.offerFob.toFixed(3));
    const r = ws.addRow([it.ref, it.line, buyerDescription(it), it.style ?? "", it.choice, it.choice === "2nd" ? buyerDescription({ ...it, description: it.defects }) : "", `${it.ply ?? ""}${it.flute && it.flute !== "—" ? " · " + it.flute : ""}`,
      `${it.length_mm}×${it.width_mm}×${it.height_mm}`, it.print ?? "", it.coating ?? "", it.food_safe ? "Yes" : "No", it.qty, it.moq ?? "", price, pcsPer40(it.cbm_per_1000), it.lead_days ?? 0, "", ""]);
    r.font = { size: 9 };
    r.getCell(17).fill = r.getCell(18).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDF1EC" } };
  }
  [16, 22, 30, 12, 8, 26, 12, 16, 10, 10, 9, 12, 10, 14, 12, 10, 10, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(12).numFmt = "#,##0"; ws.getColumn(14).numFmt = "0.000"; ws.getColumn(15).numFmt = "#,##0";
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const safe = m.buyer.name.replace(/[^\w]+/g, "_").slice(0, 40);
  return storeFile(buf, `CP_material_list_S${sendoutId}_${safe}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/** Keep outreach in the local outbox; live SMTP delivery is disabled by policy. */
export async function deliver(msg: { to: string; toName: string; fromName: string; subject: string; body: string; attachment?: string | null; sendoutId: number; messageId: number }) {
  const from = `"${msg.fromName} · Cardboard Package" <${process.env.MAIL_FROM ?? "trade@cardboardpackage.com"}>`;
  const attachments = msg.attachment ? [{ filename: path.basename(msg.attachment).replace(/^[0-9a-f]{12}-/, ""), path: fileAbs(msg.attachment) }] : [];
  const mail = { from, to: `"${msg.toName}" <${msg.to}>`, subject: msg.subject, text: msg.body, attachments };
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await t.sendMail(mail);
  const dir = path.join(OUTBOX_DIR, `sendout-${msg.sendoutId}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${msg.messageId}-${msg.to.replace(/[^\w.@-]/g, "_")}.eml`);
  fs.writeFileSync(file, info.message as Buffer);
  return { status: "outbox" as const, eml: path.relative(OUTBOX_DIR, file) };
}

export const optionsOf = (s: string | null | undefined): SendoutOptions => ({ ...DEFAULT_OPTIONS, ...json<Partial<SendoutOptions>>(s, {}) });
