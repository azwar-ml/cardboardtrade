import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { currentUser } from "@/lib/trade/auth";
import { queryInventory } from "@/lib/trade/inventory";
import { lanes, pcsPer40, pricingSettings, quote } from "@/lib/trade/pricing";

export const runtime = "nodejs";

// Internal export of the filtered virtual inventory, including vendor and cost build-up (never send this to buyers).
export async function GET(req: Request) {
  if (!(await currentUser())) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const f = Object.fromEntries(new URL(req.url).searchParams);
  const { rows } = queryInventory(f, 20000);
  const s = pricingSettings();
  const selectedLane = f.port ? lanes().find((l) => l.code === f.port) : undefined;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Inventory (internal)", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols: [string, number][] = [["Ref", 16], ["Vendor", 26], ["Vendor SKU", 16], ["Family", 18], ["Product", 20], ["Description", 32], ["Style", 12], ["Choice", 8], ["Defects", 24], ["Ply", 6], ["Flute", 7], ["L mm", 8], ["W mm", 8], ["H mm", 8], ["Print", 10], ["Coating", 12], ["Food safe", 9], ["Qty pcs", 10], ["MOQ", 9], ["Location", 12], ["Lead days", 9], ["Vendor price", 11], ["Cur", 6], ["EXW USD/pc", 11], ["FOB KHI USD/pc", 13], [`Offer FOB +${s.marginPct}%`, 14], ["CBM / 1000", 11], ["kg / 1000", 10], ["Pcs per 40HC", 12], ["Price source", 12], ["Status", 9]];
  if (selectedLane) cols.splice(26, 0, [`Cost CFR ${selectedLane.port} USD/pc`, 18], [`Offer CFR ${selectedLane.port} USD/pc`, 19]);
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E1013" } }));
  for (const r of rows) {
    const q = quote(r, f.port ?? null, s);
    const values = [r.ref, r.vendor, r.vendor_sku, r.family, r.line, r.description, r.style, r.choice, r.defects, r.ply, r.flute, r.length_mm, r.width_mm, r.height_mm, r.print, r.coating, r.food_safe ? "Y" : "N", r.qty, r.moq, r.location, r.lead_days, r.price, r.currency,
      +q.exwUsd.toFixed(4), +q.fobUsd.toFixed(4), +q.offerFob.toFixed(4)];
    if (selectedLane) values.push(q.cfrUsd == null ? "" : +q.cfrUsd.toFixed(4), q.offerCfr == null ? "" : +q.offerCfr.toFixed(4));
    values.push(+r.cbm_per_1000.toFixed(3), +r.kg_per_1000.toFixed(1), pcsPer40(r.cbm_per_1000), r.price_source, r.status);
    ws.addRow(values);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return new NextResponse(buf, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="CP_inventory_${new Date().toISOString().slice(0, 10)}.xlsx"` } });
}
