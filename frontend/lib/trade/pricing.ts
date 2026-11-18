import "server-only";
import { db, getSetting } from "./db";
import { CBM_PER_40HC, DEFAULT_INLAND_USD_PER_CBM, PLY_THICKNESS_MM } from "./catalog";

export type PricingSettings = { fxPkrPerUsd: number; marginPct: number; fobUsdPerCbm: number; minMarginUsdPerPc: number };

export function pricingSettings(): PricingSettings {
  const fx = Number(getSetting("fx_pkr_per_usd", "280"));
  const margin = Number(getSetting("margin_pct", "12"));
  const fob = Number(getSetting("fob_usd_per_cbm", "9"));
  const minimum = Number(getSetting("min_margin_usd_per_pc", "0.005"));
  return {
    fxPkrPerUsd: Number.isFinite(fx) && fx > 0 ? fx : 280,
    marginPct: Number.isFinite(margin) && margin >= 0 ? margin : 12,
    fobUsdPerCbm: Number.isFinite(fob) && fob >= 0 ? fob : 9,
    minMarginUsdPerPc: Number.isFinite(minimum) && minimum >= 0 ? minimum : 0.005,
  };
}

type Lane = { code: string; port: string; country: string; rate_40hc_usd: number; transit_days: number };
export function lanes(): Lane[] {
  return db().prepare("SELECT code, port, country, rate_40hc_usd, transit_days FROM freight_lanes WHERE active = 1 ORDER BY region, port").all() as Lane[];
}
export function lane(code: string | null | undefined): Lane | undefined {
  if (!code) return undefined;
  return db().prepare("SELECT code, port, country, rate_40hc_usd, transit_days FROM freight_lanes WHERE code = ?").get(code) as Lane | undefined;
}
export function inlandRate(city: string) {
  const r = db().prepare("SELECT inland_usd_per_cbm FROM origins WHERE city = ?").get(city) as { inland_usd_per_cbm: number } | undefined;
  return r?.inland_usd_per_cbm ?? DEFAULT_INLAND_USD_PER_CBM;
}

/** Shipping volume and weight of 1,000 pcs. Uses the vendor's bundle data when given, else estimates a knocked-down carton. */
export function volumeOf(x: { line: string; ply: string | null; length_mm: number; width_mm: number; height_mm: number; bundle_qty?: number | null; bundle_l_cm?: number | null; bundle_w_cm?: number | null; bundle_h_cm?: number | null; bundle_kg?: number | null; unit_g?: number | null; gsm?: number | null }) {
  if (x.bundle_qty && x.bundle_l_cm && x.bundle_w_cm && x.bundle_h_cm) {
    const cbm = (x.bundle_l_cm * x.bundle_w_cm * x.bundle_h_cm) / 1e6;
    const per1000 = (cbm / x.bundle_qty) * 1000;
    const kg = x.bundle_kg ? (x.bundle_kg / x.bundle_qty) * 1000 : x.unit_g ? x.unit_g : per1000 * 120;
    return { cbmPer1000: per1000, kgPer1000: kg, estimated: false };
  }
  const { area, flat } = flatArea(x);
  const thick = (PLY_THICKNESS_MM[x.ply ?? "3"] ?? 3.6) / 1000;
  const per1000 = flat * thick * 1000 * 1.18;                       // packing factor for straps and pallets
  const gsmTotal = x.gsm ?? (x.ply === "7" ? 1000 : x.ply === "5" ? 700 : x.ply === "3" ? 430 : 300);
  const kg = x.unit_g ? x.unit_g : area * gsmTotal;                   // g per pc ≈ kg per 1000
  return { cbmPer1000: per1000, kgPer1000: kg, estimated: true };
}

/** Board area (m²) of one piece and its knocked-down footprint (m²). */
export function flatArea(x: { line: string; length_mm: number; width_mm: number; height_mm: number }) {
  const L = x.length_mm / 1000, W = x.width_mm / 1000, H = x.height_mm / 1000;
  if (/Bag/.test(x.line)) { const a = (2 * (L + W) + 0.03) * (H + W * 0.75); return { area: a, flat: L * H }; }
  if (x.line === "Beverages") { const a = Math.max(L * W * 2, 0.02); return { area: a, flat: L * W }; }
  if (x.line === "Pizza" || x.line === "Laptop") { const a = (L + 2 * H + 0.04) * (2 * W + 3 * H + 0.04); return { area: a, flat: a }; }
  const a = (2 * L + 2 * W + 0.04) * (W + H + 0.01);                // RSC blank
  return { area: a, flat: a / 2 };                                   // folded flat in half
}

export type Quote = { exwUsd: number; fobUsd: number; cfrUsd: number | null; offerFob: number; offerCfr: number | null; freightUsdPerPc: number | null; port: string | null; transit: number | null };

/** Per-piece pricing: EXW (vendor) → FOB Karachi (inland + port charges) → CFR (ocean share by volume), then margin. */
export function quote(item: { price_pkr: number; price?: number; currency?: string; cbm_per_1000: number; location: string }, portCode?: string | null, s = pricingSettings()): Quote {
  if (!Number.isFinite(s.fxPkrPerUsd) || s.fxPkrPerUsd <= 0) throw new Error("FX rate must be a finite positive value.");
  const cbmPc = item.cbm_per_1000 / 1000;
  const exwUsd = item.currency === "USD" ? Number(item.price) : item.price_pkr / s.fxPkrPerUsd;
  const fobUsd = exwUsd + cbmPc * (inlandRate(item.location) + s.fobUsdPerCbm);
  const l = lane(portCode);
  const freight = l ? cbmPc * (l.rate_40hc_usd / CBM_PER_40HC) : null;
  const cfrUsd = freight != null ? fobUsd + freight : null;
  const withMargin = (c: number) => Math.max(c * (1 + s.marginPct / 100), c + s.minMarginUsdPerPc);
  return { exwUsd, fobUsd, cfrUsd, offerFob: withMargin(fobUsd), offerCfr: cfrUsd != null ? withMargin(cfrUsd) : null, freightUsdPerPc: freight, port: l ? `${l.port}, ${l.country}` : null, transit: l?.transit_days ?? null };
}

/** How many pieces of an item fit into one 40ft HC. */
export const pcsPer40 = (cbmPer1000: number) => Math.floor((CBM_PER_40HC / cbmPer1000) * 1000);

export const usd = (n: number | null | undefined, digits = 3) => (n == null ? "—" : `$${n.toFixed(digits)}`);
export const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
