import "server-only";
import ExcelJS from "exceljs";
import { CHOICES, CHOICE_NOTES, COATINGS, CURRENCIES, DIM_TYPES, FLUTES, LINES, ORIGIN_CITIES, PLIES, PRINTS, STYLES } from "./catalog";

/** The Cardboard Package supplier inventory format (sheet BULK_UPLOAD). One row = one lot of identical pieces at one location. */
export type Col = { key: string; header: string; required?: boolean; type: "text" | "int" | "num" | "enum" | "date" | "bool"; options?: string[]; help: string; width?: number };

export const COLUMNS: Col[] = [
  { key: "vendor_sku", header: "Supplier SKU", required: true, type: "text", help: "Your own article / lot number. Must be unique within the file.", width: 16 },
  { key: "line", header: "Product line", required: true, type: "enum", options: LINES, help: "Pick from the list.", width: 22 },
  { key: "description", header: "Description", type: "text", help: "Short free text, e.g. '55in LED TV outer carton with EPS slots'.", width: 34 },
  { key: "style", header: "Style", required: true, type: "enum", options: STYLES, help: "Carton or bag construction (RSC = regular slotted carton).", width: 14 },
  { key: "choice", header: "Choice", required: true, type: "enum", options: [...CHOICES], help: `1st = ${CHOICE_NOTES["1st"]} 2nd = ${CHOICE_NOTES["2nd"]}`, width: 9 },
  { key: "defects", header: "Defect notes", type: "text", help: "Required for 2nd choice: what is wrong (print shift, colour, overrun…).", width: 26 },
  { key: "ply", header: "Ply", required: true, type: "enum", options: PLIES, help: "3, 5 or 7 for corrugated; Board for folding board, bags and cups.", width: 7 },
  { key: "flute", header: "Flute", type: "enum", options: FLUTES, help: "E, B, C or combination. — for non-corrugated.", width: 8 },
  { key: "board", header: "Board / liner build", type: "text", help: "e.g. K150/T125/K150 (kraft / test / kraft, GSM).", width: 18 },
  { key: "gsm", header: "Total GSM", type: "num", help: "Grammage of the combined board, or paper GSM for bags.", width: 10 },
  { key: "length_mm", header: "Length mm", required: true, type: "num", help: "Millimetres.", width: 10 },
  { key: "width_mm", header: "Width mm", required: true, type: "num", help: "Millimetres.", width: 10 },
  { key: "height_mm", header: "Height mm", required: true, type: "num", help: "Millimetres (bag: height; cup sleeve: height).", width: 10 },
  { key: "dim_type", header: "Dimension type", type: "enum", options: DIM_TYPES, help: "Internal (default), External or Flat blank size.", width: 12 },
  { key: "print", header: "Print", type: "enum", options: PRINTS, help: "Plain or number of colours.", width: 10 },
  { key: "coating", header: "Coating", type: "enum", options: COATINGS, help: "Wax for produce, PE for liquid, etc.", width: 12 },
  { key: "food_safe", header: "Food safe (Y/N)", type: "bool", help: "Y only if you can provide a food-contact declaration.", width: 10 },
  { key: "qty", header: "Qty available pcs", required: true, type: "int", help: "Pieces ready or reservable now.", width: 12 },
  { key: "moq", header: "MOQ pcs", type: "int", help: "Smallest quantity you will sell from this lot.", width: 10 },
  { key: "price", header: "Unit price", required: true, type: "num", help: "Price per piece, EXW your factory, excluding tax.", width: 10 },
  { key: "currency", header: "Currency", required: true, type: "enum", options: CURRENCIES, help: "PKR or USD.", width: 9 },
  { key: "bundle_qty", header: "Pcs per bundle", type: "int", help: "Pieces per strapped bundle or bale. Lets us price freight exactly.", width: 11 },
  { key: "bundle_l_cm", header: "Bundle L cm", type: "num", help: "Bundle length, cm.", width: 10 },
  { key: "bundle_w_cm", header: "Bundle W cm", type: "num", help: "Bundle width, cm.", width: 10 },
  { key: "bundle_h_cm", header: "Bundle H cm", type: "num", help: "Bundle height, cm.", width: 10 },
  { key: "bundle_kg", header: "Bundle weight kg", type: "num", help: "Gross weight of one bundle.", width: 11 },
  { key: "location", header: "Stock location city", required: true, type: "enum", options: ORIGIN_CITIES, help: "City where the goods are collected.", width: 14 },
  { key: "lead_days", header: "Lead time days", type: "int", help: "Days until ready to collect (0 = in stock).", width: 10 },
  { key: "valid_until", header: "Price valid until", type: "date", help: "YYYY-MM-DD.", width: 13 },
  { key: "certifications", header: "Certifications", type: "text", help: "e.g. FSC, ISO 9001, ISO 22000, BRCGS.", width: 18 },
  { key: "photos", header: "Photos available (Y/N)", type: "bool", help: "Y if you can send photos of the actual lot on request.", width: 11 },
  { key: "notes", header: "Notes", type: "text", help: "Anything else buyers should know.", width: 24 },
];

export type Row = Record<string, string | number | boolean | null>;
export type Issue = { row: number; column: string; level: "error" | "warning"; message: string };

const norm = (s: unknown) => String(s ?? "").trim();
const lc = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** Read the BULK_UPLOAD sheet (or the first sheet) of an xlsx, or a CSV, into raw rows keyed by header text. */
export async function readTabular(buf: Buffer, filename: string): Promise<{ headers: string[]; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) {
    const { Readable } = await import("node:stream");
    await wb.csv.read(Readable.from(buf.toString("utf8")));
  } else {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  }
  const ws = wb.getWorksheet("BULK_UPLOAD") ?? wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const all: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals: string[] = [];
    r.eachCell({ includeEmpty: true }, (c, i) => {
      const v = c.value as unknown;
      let s: string;
      if (v instanceof Date) s = v.toISOString().slice(0, 10);
      else if (v && typeof v === "object" && "result" in (v as object)) s = norm((v as { result: unknown }).result);
      else if (v && typeof v === "object" && "text" in (v as object)) s = norm((v as { text: unknown }).text);
      else if (v && typeof v === "object" && "richText" in (v as object)) s = ((v as { richText: { text: string }[] }).richText).map((t) => t.text).join("");
      else s = norm(v);
      vals[i - 1] = s;
    });
    all.push(vals.map((x) => x ?? ""));
  });
  // header row = first row that contains "Supplier SKU"
  const hi = all.findIndex((r) => r.some((c) => lc(c.replace(/\s*\*\s*$/, "")) === "supplier sku"));
  if (hi < 0) return { headers: [], rows: [] };
  // drop empty rows and the template's example row (SKU starting with EXAMPLE)
  const sku = all[hi].findIndex((c) => lc(c.replace(/\s*\*\s*$/, "")) === "supplier sku");
  return { headers: all[hi], rows: all.slice(hi + 1).filter((r) => r.some((c) => c !== "") && !/^example/i.test(r[sku] ?? "")) };
}

/** Contract check: map headers, coerce types, validate values. Returns clean rows and the issues found. */
export function checkRows(headers: string[], rows: string[][]): { rows: Row[]; issues: Issue[]; okIdx: number[] } {
  const issues: Issue[] = [];
  const idx: Record<string, number> = {};
  for (const c of COLUMNS) {
    const i = headers.findIndex((h) => headerMatches(h, c));
    if (i >= 0) idx[c.key] = i;
    else if (c.required) issues.push({ row: 0, column: c.header, level: "error", message: "Column is missing from the file." });
  }
  if (issues.some((x) => x.row === 0)) return { rows: [], issues, okIdx: [] };

  const out: Row[] = [];
  const okIdx: number[] = [];
  const seen = new Set<string>();
  rows.forEach((r, n) => {
    const rowNo = n + 2; // header is row 1 for the user
    const row: Row = {};
    let bad = false;
    const err = (col: Col, message: string, level: "error" | "warning" = "error") => { issues.push({ row: rowNo, column: col.header, level, message }); if (level === "error") bad = true; };
    for (const c of COLUMNS) {
      const raw = idx[c.key] != null ? norm(r[idx[c.key]]) : "";
      if (!raw) { if (c.required) err(c, "Required value is empty."); row[c.key] = null; continue; }
      switch (c.type) {
        case "int": case "num": {
          const v = Number(raw.replace(/[, ]/g, ""));
          if (!Number.isFinite(v) || v < 0) err(c, `“${raw}” is not a valid number.`);
          else if (c.type === "int" && !Number.isInteger(v)) err(c, `“${raw}” must be a whole number.`);
          row[c.key] = v; break;
        }
        case "enum": {
          const hit = c.options!.find((o) => lc(o) === lc(raw) || lc(o).replace(/[^a-z0-9]/g, "") === lc(raw).replace(/[^a-z0-9]/g, ""));
          if (!hit) err(c, `“${raw}” is not one of the allowed values.`);
          row[c.key] = hit ?? raw; break;
        }
        case "bool": row[c.key] = /^(y|yes|true|1)$/i.test(raw); break;
        case "date": {
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) err(c, `“${raw}” is not a date (use YYYY-MM-DD).`);
          row[c.key] = Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); break;
        }
        default: row[c.key] = raw;
      }
    }
    const col = (k: string) => COLUMNS.find((c) => c.key === k)!;
    if (row.vendor_sku) { if (seen.has(String(row.vendor_sku))) err(col("vendor_sku"), "Duplicate SKU in this file."); seen.add(String(row.vendor_sku)); }
    if (row.choice === "2nd" && !row.defects) err(col("defects"), "2nd choice needs a defect note so buyers know what they get.");
    for (const k of ["length_mm", "width_mm", "height_mm"]) if (typeof row[k] === "number" && ((row[k] as number) < 10 || (row[k] as number) > 3000)) err(col(k), "Outside 10–3000 mm. Is this in mm?");
    if (typeof row.qty === "number" && row.qty === 0) err(col("qty"), "Quantity is 0.");
    if (row.currency === "PKR" && typeof row.price === "number" && row.price > 20000) err(col("price"), "Very high PKR price per piece. Check unit.", "warning");
    if (row.currency === "USD" && typeof row.price === "number" && row.price > 80) err(col("price"), "Very high USD price per piece. Check unit.", "warning");
    if (row.moq && row.qty && (row.moq as number) > (row.qty as number)) err(col("moq"), "MOQ is larger than the quantity available.", "warning");
    if (row.bundle_qty && !(row.bundle_l_cm && row.bundle_w_cm && row.bundle_h_cm)) err(col("bundle_l_cm"), "Bundle size incomplete; freight will be estimated.", "warning");
    out.push(row);
    if (!bad) okIdx.push(n);
  });
  return { rows: out, issues, okIdx };
}

/** Build the supplier template workbook. Optionally pre-filled with rows (used for demo vendor lists). */
export async function templateWorkbook(opts: { vendorName?: string; rows?: Row[] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Cardboard Package";
  const ink = "FF0E1013", bone = "FFF2EFE9", accent = "FFE35B2C";

  const info = wb.addWorksheet("READ ME", { views: [{ showGridLines: false }] });
  info.getColumn(1).width = 4; info.getColumn(2).width = 28; info.getColumn(3).width = 90;
  info.getCell("B2").value = "Cardboard Package · Supplier inventory format";
  info.getCell("B2").font = { name: "Arial", size: 16, bold: true, color: { argb: ink } };
  info.getCell("B3").value = opts.vendorName ? `Prepared for ${opts.vendorName}` : "Fill one row per lot in the BULK_UPLOAD sheet and send it back to your account manager.";
  info.getCell("B3").font = { name: "Arial", size: 10, color: { argb: "FF62666D" } };
  const steps = [
    ["1", "Fill BULK_UPLOAD: one row = one lot of identical pieces at one location. Do not rename or reorder the header row."],
    ["2", "Required columns are marked * and shaded. Dropdowns show the allowed values."],
    ["3", "Prices are per piece, EXW your factory, excluding tax. We add freight and quote buyers ourselves; your name is never shown to buyers."],
    ["4", "Give bundle size and weight if you can: freight is then priced exactly instead of estimated."],
    ["5", "Choice: " + CHOICE_NOTES["1st"] + " / " + CHOICE_NOTES["2nd"]],
    ["6", "You can also send stock in any format (Excel, PDF, photos, WhatsApp text). Our team converts it into this format for you."],
  ];
  steps.forEach(([n, t], i) => { info.getCell(`B${5 + i}`).value = n; info.getCell(`C${5 + i}`).value = t; info.getCell(`C${5 + i}`).alignment = { wrapText: true, vertical: "top" }; info.getRow(5 + i).height = 30; });
  info.getCell("B12").value = "Column guide"; info.getCell("B12").font = { bold: true, size: 12 };
  COLUMNS.forEach((c, i) => {
    const r = 13 + i;
    info.getCell(`B${r}`).value = c.header + (c.required ? " *" : "");
    info.getCell(`C${r}`).value = c.help + (c.options && c.options.length <= 20 ? `  Allowed: ${c.options.join(", ")}` : "");
    info.getCell(`C${r}`).alignment = { wrapText: true, vertical: "top" };
    info.getCell(`B${r}`).font = { bold: !!c.required };
  });

  const ws = wb.addWorksheet("BULK_UPLOAD", { views: [{ state: "frozen", ySplit: 1, xSplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header + (c.required ? " *" : ""), key: c.key, width: c.width ?? 12 }));
  const head = ws.getRow(1);
  head.height = 34;
  head.eachCell((cell, i) => {
    const c = COLUMNS[i - 1];
    cell.font = { name: "Arial", bold: true, size: 9, color: { argb: c.required ? "FFFFFFFF" : ink } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.required ? ink : bone } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    (cell as unknown as { note: string }).note = c.help;
  });
  // headers are matched without the " *", so strip it in the matching key but keep it visible: we store plain header in row 1 value
  head.eachCell((cell, i) => { cell.value = COLUMNS[i - 1].header + (COLUMNS[i - 1].required ? " *" : ""); });

  // lists for validation
  const lists = wb.addWorksheet("lists", { state: "veryHidden" });
  const enums = COLUMNS.filter((c) => c.type === "enum" || c.type === "bool");
  enums.forEach((c, j) => {
    const opts = c.type === "bool" ? ["Y", "N"] : c.options!;
    opts.forEach((o, i) => { lists.getCell(i + 1, j + 1).value = o; });
    const colLetter = lists.getColumn(j + 1).letter;
    const target = ws.getColumn(c.key).letter;
    for (let r = 2; r <= 2000; r++) ws.getCell(`${target}${r}`).dataValidation = { type: "list", allowBlank: !c.required, formulae: [`lists!$${colLetter}$1:$${colLetter}$${opts.length}`], showErrorMessage: true, errorTitle: "Not allowed", error: `Choose a value for ${c.header}` };
  });
  for (const c of COLUMNS.filter((c) => c.type === "int" || c.type === "num")) {
    const L = ws.getColumn(c.key).letter;
    for (let r = 2; r <= 2000; r++) ws.getCell(`${L}${r}`).dataValidation = { type: "decimal", operator: "greaterThanOrEqual", allowBlank: !c.required, formulae: [0], showErrorMessage: true, error: "Enter a number ≥ 0" };
  }

  const example: Row = { vendor_sku: "EXAMPLE-delete-me", line: "TV Box", description: "55in LED TV outer carton, handle holes", style: "RSC", choice: "1st", defects: null, ply: "5", flute: "BC", board: "K175/T150/T125/T150/K175", gsm: 900,
    length_mm: 1340, width_mm: 160, height_mm: 830, dim_type: "Internal", print: "2-colour", coating: "None", food_safe: false, qty: 5000, moq: 1000, price: 395, currency: "PKR",
    bundle_qty: 10, bundle_l_cm: 150, bundle_w_cm: 95, bundle_h_cm: 7, bundle_kg: 32, location: "Lahore", lead_days: 7, valid_until: "2026-12-31", certifications: "ISO 9001", photos: true, notes: "Example row — rows whose SKU starts with EXAMPLE are ignored on upload." };
  // write rows from row 2 explicitly (addRow would append after the 2,000 validated rows)
  (opts.rows?.length ? opts.rows : [example]).forEach((row, n) => {
    const r = ws.getRow(2 + n);
    COLUMNS.forEach((c, i) => {
      const v = row[c.key];
      r.getCell(i + 1).value = c.type === "bool" ? (v ? "Y" : v === false ? "N" : null) : ((v ?? null) as ExcelJS.CellValue);
    });
    r.font = { name: "Arial", size: 9 };
    if (String(row.vendor_sku ?? "").startsWith("EXAMPLE")) r.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF62666D" } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  ws.getRow(1).getCell(1).border = { bottom: { style: "medium", color: { argb: accent } } };
  return wb;
}

/** Header text as the parser expects it (asterisk-insensitive). */
export function headerMatches(h: string, c: Col) { return lc(h.replace(/\s*\*\s*$/, "")) === lc(c.header); }
