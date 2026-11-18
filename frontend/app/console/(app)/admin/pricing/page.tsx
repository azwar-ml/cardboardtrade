import { revalidatePath } from "next/cache";
import { db, setSetting } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { CBM_PER_40HC } from "@/lib/trade/catalog";
import { inlandRate, pcsPer40, pricingSettings, quote, usd } from "@/lib/trade/pricing";
import { PageHead, Panel, Td, Th } from "@/components/console/ui";

export const metadata = { title: "Pricing & Freight" };

async function saveSettings(fd: FormData) {
  "use server";
  await requireUser("admin");
  for (const k of ["fx_pkr_per_usd", "margin_pct", "fob_usd_per_cbm", "min_margin_usd_per_pc"]) {
    const v = Number(fd.get(k));
    if (Number.isFinite(v) && (k === "fx_pkr_per_usd" ? v > 0 : v >= 0)) setSetting(k, String(v));
  }
  revalidatePath("/console/admin/pricing");
}
async function saveLanes(fd: FormData) {
  "use server";
  await requireUser("admin");
  const d = db();
  d.transaction(() => {
    for (const [k, v] of fd.entries()) {
      const [kind, code] = k.split(":");
      if (kind === "rate") d.prepare("UPDATE freight_lanes SET rate_40hc_usd = ? WHERE code = ?").run(Number(v), code);
      if (kind === "transit") d.prepare("UPDATE freight_lanes SET transit_days = ? WHERE code = ?").run(Number(v), code);
      if (kind === "inland") d.prepare("UPDATE origins SET inland_usd_per_cbm = ? WHERE city = ?").run(Number(v), code);
    }
    const active = new Set(fd.getAll("active").map(String));
    for (const { code } of d.prepare("SELECT code FROM freight_lanes").all() as { code: string }[]) d.prepare("UPDATE freight_lanes SET active = ? WHERE code = ?").run(active.has(code) ? 1 : 0, code);
  })();
  revalidatePath("/console/admin/pricing");
}

export default async function Pricing() {
  await requireUser("admin");
  const s = pricingSettings();
  const lanes = db().prepare("SELECT * FROM freight_lanes ORDER BY region, port").all() as { code: string; port: string; country: string; region: string; rate_40hc_usd: number; transit_days: number; active: number }[];
  const origins = db().prepare("SELECT * FROM origins ORDER BY inland_usd_per_cbm").all() as { city: string; inland_usd_per_cbm: number }[];
  const ex = db().prepare("SELECT i.*, v.name vendor FROM items i JOIN vendors v ON v.id = i.vendor_id WHERE i.status='online' AND i.line='TV Box' ORDER BY i.length_mm DESC LIMIT 1").get() as { ref: string; description: string; price_pkr: number; cbm_per_1000: number; location: string; vendor: string } | undefined;
  const exQ = ex ? quote(ex, "AEJEA", s) : null;
  const num = (name: string, v: number, step = "any") => <input name={name} type="number" step={step} defaultValue={v} className="field !min-h-[34px] !w-24 !py-1 text-right text-sm tabular-nums" />;
  return (
    <>
      <PageHead title="Pricing & Freight" sub="How every buyer price is built. Rates are defaults to confirm with your forwarder." />
      <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
        <div className="space-y-6">
          <Panel className="p-5">
            <p className="font-medium">Price build-up per piece</p>
            <ol className="mt-3 space-y-1.5 text-sm text-stone">
              <li><span className="text-ink">EXW</span> = vendor price (PKR) ÷ FX</li>
              <li><span className="text-ink">FOB Karachi</span> = EXW + CBM/pc × (inland from city + port charges)</li>
              <li><span className="text-ink">CFR port</span> = FOB + CBM/pc × (40HC ocean rate ÷ {CBM_PER_40HC} CBM)</li>
              <li><span className="text-ink">Offer</span> = cost × (1 + margin), never less than cost + minimum margin</li>
            </ol>
            <p className="mt-3 text-[12px] text-stone">CBM per piece comes from the vendor&apos;s bundle size and count, or is estimated from the knocked-down carton (blank area × ply thickness × 1.18 packing).</p>
          </Panel>
          <Panel className="p-5">
            <form action={saveSettings} className="space-y-3">
              <p className="font-medium">Settings</p>
              {[["fx_pkr_per_usd", "PKR per USD", s.fxPkrPerUsd], ["margin_pct", "Margin %", s.marginPct], ["fob_usd_per_cbm", "Karachi port & docs, USD per CBM", s.fobUsdPerCbm], ["min_margin_usd_per_pc", "Minimum margin, USD per piece", s.minMarginUsdPerPc]].map(([k, l, v]) => (
                <label key={String(k)} className="flex items-center justify-between gap-4 border-b border-line/70 pb-2 text-sm">{l}{num(String(k), Number(v))}</label>
              ))}
              <button className="btn btn-ink !h-10">Save settings</button>
            </form>
          </Panel>
          {ex && exQ && (
            <Panel className="p-5">
              <p className="font-medium">Worked example</p>
              <p className="mt-1 text-sm text-stone">{ex.ref} · {ex.description} · {ex.vendor} ({ex.location}) → Jebel Ali</p>
              <dl className="mt-3 space-y-1.5 text-sm tabular-nums">
                {[["Vendor price", `Rs ${ex.price_pkr.toFixed(1)}`], ["EXW", usd(exQ.exwUsd)], ["CBM per piece", (ex.cbm_per_1000 / 1000).toFixed(4)], [`Inland ${ex.location}→Karachi + port`, usd(exQ.fobUsd - exQ.exwUsd)], ["FOB Karachi", usd(exQ.fobUsd)], ["Ocean freight share", usd(exQ.freightUsdPerPc)], ["CFR Jebel Ali (cost)", usd(exQ.cfrUsd)], [`Offer +${s.marginPct}%`, usd(exQ.offerCfr)], ["Pieces per 40HC", pcsPer40(ex.cbm_per_1000).toLocaleString("en-US")]].map(([k, v]) => (
                  <div key={String(k)} className="flex justify-between border-b border-line/60 pb-1.5"><dt className="text-stone">{k}</dt><dd className="font-medium">{v}</dd></div>
                ))}
              </dl>
              <p className="mt-2 text-[12px] text-stone">Inland rate for {ex.location}: ${inlandRate(ex.location)}/CBM.</p>
            </Panel>
          )}
        </div>
        <form action={saveLanes} className="space-y-6">
          <Panel className="overflow-x-auto">
            <p className="border-b border-line px-4 py-3 font-medium">Ocean freight from Karachi (40ft HC)</p>
            <table className="w-full"><thead><tr><Th>On</Th><Th>Port</Th><Th>Region</Th><Th className="text-right">USD / 40HC</Th><Th className="text-right">USD / CBM</Th><Th className="text-right">Transit days</Th></tr></thead>
              <tbody>{lanes.map((l) => (
                <tr key={l.code}><Td><input type="checkbox" name="active" value={l.code} defaultChecked={!!l.active} className="accent-accent" /></Td><Td>{l.port}<span className="block text-[12px] text-stone">{l.country} · {l.code}</span></Td><Td>{l.region}</Td>
                  <Td className="text-right">{num(`rate:${l.code}`, l.rate_40hc_usd)}</Td><Td className="text-right tabular-nums text-stone">{(l.rate_40hc_usd / CBM_PER_40HC).toFixed(1)}</Td><Td className="text-right">{num(`transit:${l.code}`, l.transit_days, "1")}</Td></tr>))}</tbody></table>
          </Panel>
          <Panel className="overflow-x-auto">
            <p className="border-b border-line px-4 py-3 font-medium">Inland freight to Karachi port</p>
            <table className="w-full"><thead><tr><Th>Pick-up city</Th><Th className="text-right">USD / CBM</Th></tr></thead>
              <tbody>{origins.map((o) => <tr key={o.city}><Td>{o.city}</Td><Td className="text-right">{num(`inland:${o.city}`, o.inland_usd_per_cbm)}</Td></tr>)}</tbody></table>
          </Panel>
          <button className="btn btn-ink">Save freight rates</button>
        </form>
      </div>
    </>
  );
}
