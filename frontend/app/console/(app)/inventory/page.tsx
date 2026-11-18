import { inventoryFreshness } from "@/lib/trade/inventory-freshness";
import CatalogInventory from "@/components/console/CatalogInventory";
import Link from "next/link";
import { Download } from "lucide-react";
import { db } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { queryInventory, type InvFilters } from "@/lib/trade/inventory";
import { FAMILIES, FLUTES, LINES, ORIGIN_CITIES, PLIES } from "@/lib/trade/catalog";
import { lanes, pcsPer40, pricingSettings, quote, usd } from "@/lib/trade/pricing";
import { PageHead, Panel, Pill, Td, Th, fmtDate, fmtInt, statusTone } from "@/components/console/ui";

export const metadata = { title: "Inventory" };

export default async function Inventory({ searchParams }: { searchParams: Promise<InvFilters & { view?: string; product?: string; page?: string }> }) {
  const user = await requireUser();
  const f = await searchParams;
  if (f.view === "catalog") return <CatalogInventory filters={f} admin={user.role === "admin"} />;
  const { rows, total } = queryInventory(f);
  const vendors = db().prepare("SELECT DISTINCT v.id, v.name FROM vendors v JOIN items i ON i.vendor_id = v.id ORDER BY v.name").all() as { id: number; name: string }[];
  const view = f.view === "specs" ? "specs" : "pricing";
  const s = pricingSettings();
  const ls = lanes();
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...(f as Record<string, string>), ...extra }).toString();
  const sel = "field !min-h-[38px] !w-auto !py-1.5 text-sm";
  return (
    <>
      <PageHead title="Inventory" sub={<>{fmtInt(total.n)} lots · {fmtInt(total.pcs)} pcs · {fmtInt(total.cbm)} CBM shipping volume</>}>
        <a href={`/api/console/inventory/export?${qs({})}`} className="btn btn-line !h-10 text-ink"><Download className="size-4" />Export</a>
        <Link href="/console/inventory?view=catalog" className="btn btn-line !h-10">Supplier catalog</Link>
        <Link href="/console/uploads/new" className="btn btn-ink !h-10">Upload a list</Link>
      </PageHead>

      <Panel className="mb-4 p-3">
        <form className="flex flex-wrap items-center gap-2">
          <input name="q" defaultValue={f.q} placeholder="Search ref, SKU, vendor, description…" className="field !min-h-[38px] !w-64 !py-1.5 text-sm" />
          <select name="vendor" defaultValue={f.vendor ?? ""} className={sel}><option value="">All vendors</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <select name="family" defaultValue={f.family ?? ""} className={sel}><option value="">All families</option>{FAMILIES.map((x) => <option key={x}>{x}</option>)}</select>
          <select name="line" defaultValue={f.line ?? ""} className={sel}><option value="">All products</option>{LINES.map((x) => <option key={x}>{x}</option>)}</select>
          <select name="choice" defaultValue={f.choice ?? ""} className={sel}><option value="">Any choice</option><option>1st</option><option>2nd</option></select>
          <select name="ply" defaultValue={f.ply ?? ""} className={sel}><option value="">Any ply</option>{PLIES.map((x) => <option key={x}>{x}</option>)}</select>
          <select name="flute" defaultValue={f.flute ?? ""} className={sel}><option value="">Any flute</option>{FLUTES.filter((x) => x !== "—").map((x) => <option key={x}>{x}</option>)}</select>
          <input name="material" defaultValue={f.material} placeholder="Board / GSM / coating" className="field !min-h-[38px] !w-40 !py-1.5 text-sm" />
          <select name="location" defaultValue={f.location ?? ""} className={sel}><option value="">Any location</option>{ORIGIN_CITIES.map((x) => <option key={x}>{x}</option>)}</select>
          <select name="status" defaultValue={f.status ?? "online"} className={sel}>{["online", "reserved", "sold", "offline"].map((x) => <option key={x}>{x}</option>)}</select>
          <input name="minQty" defaultValue={f.minQty} placeholder="Min qty" className="field !min-h-[38px] !w-24 !py-1.5 text-sm" />
          <select name="port" defaultValue={f.port ?? ""} className={sel} title="Show CFR price to this port"><option value="">Price FOB Karachi</option>{ls.map((l) => <option key={l.code} value={l.code}>CFR {l.port}</option>)}</select>
          <input type="hidden" name="view" value={view} />
          <button className="btn btn-ink !h-[38px] !px-4 text-sm">Apply</button>
          <Link href="/console/inventory" className="px-2 text-sm text-stone hover:text-ink">Reset</Link>
          <span className="ml-auto flex overflow-hidden rounded-[6px] border border-line text-sm">
            <Link href={`?${qs({ view: "pricing" })}`} className={`px-3 py-1.5 ${view === "pricing" ? "bg-ink text-white" : "bg-white"}`}>Pricing</Link>
            <Link href={`?${qs({ view: "specs" })}`} className={`px-3 py-1.5 ${view === "specs" ? "bg-ink text-white" : "bg-white"}`}>Specs</Link>
          </span>
        </form>
      </Panel>

      <Panel className="overflow-x-auto">
        <table className="w-full">
          <thead><tr>
            <Th>Ref</Th><Th>Vendor</Th><Th>Product</Th><Th>Choice</Th><Th>Size L×W×H mm</Th><Th>Ply</Th><Th className="text-right">Qty</Th><Th>Location</Th>
            {view === "pricing" ? (<><Th className="text-right">Vendor price</Th><Th className="text-right">EXW $</Th><Th className="text-right">FOB KHI $</Th><Th className="text-right">{f.port ? "CFR $" : "—"}</Th><Th className="text-right">Offer $ (+{s.marginPct}%)</Th><Th className="text-right">Pcs / 40HC</Th><Th>Source</Th></>)
              : (<><Th>Style</Th><Th>Flute</Th><Th>Board</Th><Th>Print</Th><Th>Coating</Th><Th>Food</Th><Th className="text-right">MOQ</Th><Th>Lead</Th><Th>Defects</Th><Th>Status</Th><Th>Uploaded</Th></>)}
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const q = quote(r, f.port, s);
              return (
                <tr key={r.id} className="hover:bg-bone/60">
                  <Td className="font-mono text-[12px]">{r.ref}</Td>
                  <Td title={r.vendor}><Link className="hover:underline" href={`/console/vendors/${r.vendor_id}`}>{r.vendor.length > 22 ? r.vendor.slice(0, 21) + "…" : r.vendor}</Link></Td>
                  <Td title={r.description ?? ""}><span className="font-medium">{r.line}</span><span className="block max-w-[16rem] truncate text-[12px] text-stone">{r.description}</span></Td>
                  <Td><Pill tone={r.choice === "1st" ? "good" : "warn"}>{r.choice}</Pill></Td>
                  <Td className="tabular-nums">{r.length_mm}×{r.width_mm}×{r.height_mm}</Td>
                  <Td>{r.ply}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(r.qty)}</Td>
                  <Td>{r.location}</Td>
                  {view === "pricing" ? (<>
                    <Td className="text-right tabular-nums">{r.currency === "PKR" ? `Rs ${r.price.toLocaleString("en-US")}` : usd(r.price)}</Td>
                    <Td className="text-right tabular-nums">{usd(q.exwUsd)}</Td>
                    <Td className="text-right tabular-nums">{usd(q.fobUsd)}</Td>
                    <Td className="text-right tabular-nums">{f.port ? usd(q.cfrUsd) : "—"}</Td>
                    <Td className="text-right font-medium tabular-nums">{usd(f.port ? q.offerCfr : q.offerFob)}</Td>
                    <Td className="text-right tabular-nums">{fmtInt(pcsPer40(r.cbm_per_1000))}</Td>
                    <Td>{r.price_source === "demo-model" ? <Pill tone="muted" title="Generated demo price">demo</Pill> : <Pill>vendor</Pill>}</Td>
                  </>) : (<>
                    <Td>{r.style}</Td><Td>{r.flute}</Td><Td className="text-[12px]">{r.board ?? (r.gsm ? `${r.gsm} gsm` : "—")}</Td><Td>{r.print}</Td><Td>{r.coating}</Td><Td>{r.food_safe ? "Yes" : "—"}</Td>
                    <Td className="text-right tabular-nums">{fmtInt(r.moq)}</Td><Td>{r.lead_days ? `${r.lead_days}d` : "Stock"}</Td>
                    <Td className="max-w-[14rem] truncate text-[12px] text-stone" title={r.defects ?? ""}>{r.defects ?? "—"}</Td>
                    <Td><Pill tone={statusTone(r.status)}>{r.status}</Pill>{inventoryFreshness("item",r.id) && <p className="mt-1 text-xs text-stone">{inventoryFreshness("item",r.id)?.freshness}</p>}</Td><Td className="text-stone">{fmtDate(r.created_at)}</Td>
                  </>)}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="p-10 text-center text-stone">No lots match these filters.</p>}
        {rows.length >= 500 && <p className="border-t border-line px-4 py-3 text-sm text-stone">Showing the first 500. Narrow the filters or export for the full list.</p>}
      </Panel>
    </>
  );
}
