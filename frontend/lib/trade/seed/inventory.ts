// Demo stock lists in the Cardboard Package template, generated per vendor from the product lines their research supports.
// Prices come from a board-cost model (BOARD_PKR_PER_M2) and are labelled demo — replace them by uploading the vendor's real list.
import { BOARD_PKR_PER_M2 } from "../catalog";
import type { Row } from "../template";

type Spec = { sku: string; desc: string; style: string; ply: string; flute: string; board?: string; gsm?: number; L: number; W: number; H: number; print: string; coating?: string; food?: boolean; qty: [number, number]; moq?: number; bundle?: number; extraPkr?: number };

const S: Record<string, Spec[]> = {
  "TV Box": [
    { sku: "TV32", desc: "32in LED TV outer carton, EPS slots", style: "RSC", ply: "5", flute: "BC", board: "K150/T125/T125/T125/K150", L: 820, W: 130, H: 520, print: "2-colour", qty: [3000, 12000], bundle: 20 },
    { sku: "TV43", desc: "43in LED TV outer carton, handle holes", style: "RSC", ply: "5", flute: "BC", board: "K175/T125/T125/T125/K175", L: 1060, W: 140, H: 660, print: "2-colour", qty: [2500, 10000], bundle: 15 },
    { sku: "TV55", desc: "55in LED TV outer carton, handle holes", style: "RSC", ply: "5", flute: "BC", board: "K175/T150/T125/T150/K175", L: 1340, W: 160, H: 830, print: "2-colour", qty: [2000, 8000], bundle: 10 },
    { sku: "TV65", desc: "65in LED TV outer carton, double wall", style: "RSC", ply: "7", flute: "BCB", board: "K200/T150/T150/T150/T150/T150/K200", L: 1580, W: 180, H: 960, print: "2-colour", qty: [1000, 5000], bundle: 10 },
    { sku: "TV85", desc: "85in TV carton, triple wall with end caps", style: "Telescope", ply: "7", flute: "BCB", L: 2050, W: 220, H: 1250, print: "1-colour", qty: [400, 1500], bundle: 5 },
  ],
  Refrigerator: [
    { sku: "RF-SD", desc: "Single-door refrigerator carton, 7-ply", style: "RSC", ply: "7", flute: "BCB", L: 600, W: 650, H: 1450, print: "2-colour", qty: [800, 4000], bundle: 5 },
    { sku: "RF-DD", desc: "Double-door refrigerator carton, 7-ply, top cap", style: "Telescope", ply: "7", flute: "BCB", L: 700, W: 720, H: 1750, print: "2-colour", qty: [600, 3000], bundle: 5 },
    { sku: "RF-SBS", desc: "Side-by-side refrigerator carton", style: "Telescope", ply: "7", flute: "BCB", L: 950, W: 780, H: 1850, print: "1-colour", qty: [300, 1200], bundle: 4 },
  ],
  "Air Conditioners": [
    { sku: "AC-IN", desc: "Split AC indoor unit carton, 1.5 ton", style: "RSC", ply: "5", flute: "BC", L: 1000, W: 300, H: 380, print: "2-colour", qty: [2000, 9000], bundle: 20 },
    { sku: "AC-OUT", desc: "Split AC outdoor unit carton, 1.5 ton", style: "RSC", ply: "7", flute: "BCB", L: 950, W: 420, H: 720, print: "2-colour", qty: [1500, 7000], bundle: 10 },
    { sku: "AC-WIN", desc: "Window AC carton", style: "RSC", ply: "7", flute: "BCB", L: 720, W: 700, H: 480, print: "1-colour", qty: [800, 3000], bundle: 10 },
  ],
  Laptop: [
    { sku: "LP14", desc: "14in laptop mailer, E-flute, 4-colour", style: "Mailer", ply: "3", flute: "E", L: 380, W: 280, H: 70, print: "4-colour", qty: [5000, 30000], bundle: 50 },
    { sku: "LP156", desc: "15.6in laptop mailer with insert", style: "Mailer", ply: "3", flute: "E", L: 420, W: 300, H: 75, print: "4-colour", qty: [4000, 25000], bundle: 50, extraPkr: 6 },
  ],
  "Iron Box": [
    { sku: "IR-DRY", desc: "Dry iron retail box, 3-ply, 4-colour", style: "RSC", ply: "3", flute: "E", L: 280, W: 140, H: 150, print: "4-colour", qty: [10000, 50000], bundle: 100 },
    { sku: "IR-STM", desc: "Steam iron retail box with window", style: "Die-cut", ply: "3", flute: "E", L: 310, W: 160, H: 170, print: "4-colour", qty: [8000, 40000], bundle: 100, extraPkr: 3 },
  ],
  Pizza: [
    { sku: "PZ08", desc: "8in pizza box, food-grade kraft", style: "Pizza box", ply: "3", flute: "E", L: 210, W: 210, H: 40, print: "1-colour", food: true, qty: [20000, 120000], bundle: 100 },
    { sku: "PZ10", desc: "10in pizza box, food-grade", style: "Pizza box", ply: "3", flute: "E", L: 260, W: 260, H: 40, print: "2-colour", food: true, qty: [20000, 100000], bundle: 100 },
    { sku: "PZ12", desc: "12in pizza box, B-flute, food-grade", style: "Pizza box", ply: "3", flute: "B", L: 310, W: 310, H: 45, print: "2-colour", food: true, qty: [20000, 100000], bundle: 50 },
    { sku: "PZ16", desc: "16in pizza box, B-flute", style: "Pizza box", ply: "3", flute: "B", L: 410, W: 410, H: 50, print: "1-colour", food: true, qty: [10000, 50000], bundle: 50 },
  ],
  "Fruit & Vegetable Crates": [
    { sku: "MG-5", desc: "Mango export tray, 5 kg, ventilated", style: "Tray", ply: "5", flute: "BC", L: 400, W: 300, H: 110, print: "2-colour", coating: "Wax", food: true, qty: [10000, 60000], bundle: 25 },
    { sku: "KN-10", desc: "Kinnow export carton, 10 kg, telescope", style: "Telescope", ply: "5", flute: "BC", L: 500, W: 330, H: 250, print: "2-colour", coating: "Water-resistant", food: true, qty: [8000, 40000], bundle: 20 },
    { sku: "VG-15", desc: "Vegetable crate, 15 kg, hand holes", style: "Crate", ply: "5", flute: "BC", L: 500, W: 350, H: 300, print: "1-colour", coating: "Wax", food: true, qty: [5000, 30000], bundle: 20 },
  ],
  "Liquid / Milk Box": [
    { sku: "MK-12x1L", desc: "Shipper case for 12 × 1 L milk packs", style: "RSC", ply: "3", flute: "B", L: 270, W: 205, H: 200, print: "2-colour", food: true, qty: [20000, 120000], bundle: 50 },
    { sku: "MK-BIB20", desc: "Bag-in-box outer carton, 20 L", style: "RSC", ply: "5", flute: "BC", L: 300, W: 250, H: 350, print: "1-colour", coating: "Water-resistant", food: true, qty: [5000, 30000], bundle: 25 },
  ],
  "Ration Box": [
    { sku: "RB-18", desc: "Ration / relief box 18×12×12 in", style: "RSC", ply: "5", flute: "BC", L: 457, W: 305, H: 305, print: "1-colour", qty: [10000, 60000], bundle: 25 },
    { sku: "RB-20", desc: "Family ration box 20×14×12 in, heavy duty", style: "RSC", ply: "5", flute: "BC", L: 508, W: 356, H: 305, print: "1-colour", qty: [8000, 40000], bundle: 20 },
    { sku: "RB-16", desc: "Ration box 16×10×9 in", style: "RSC", ply: "3", flute: "C", L: 406, W: 254, H: 229, print: "Plain", qty: [15000, 80000], bundle: 50 },
  ],
  "Shipping Box": [
    { sku: "SB-3K", desc: "Shipping box, 3 kg rated", style: "RSC", ply: "3", flute: "B", L: 300, W: 200, H: 150, print: "Plain", qty: [20000, 150000], bundle: 50 },
    { sku: "SB-10K", desc: "Shipping box, 10 kg rated", style: "RSC", ply: "5", flute: "BC", L: 400, W: 300, H: 250, print: "Plain", qty: [10000, 80000], bundle: 25 },
    { sku: "SB-20K", desc: "Export shipping box, 20 kg rated", style: "RSC", ply: "5", flute: "BC", L: 500, W: 400, H: 300, print: "1-colour", qty: [5000, 40000], bundle: 20 },
  ],
  "Universal Carton": [
    { sku: "UC-S", desc: "Universal RSC carton, small", style: "RSC", ply: "3", flute: "C", L: 350, W: 250, H: 200, print: "Plain", qty: [20000, 120000], bundle: 50 },
    { sku: "UC-M", desc: "Universal RSC carton, medium", style: "RSC", ply: "5", flute: "BC", L: 450, W: 300, H: 300, print: "Plain", qty: [10000, 80000], bundle: 25 },
    { sku: "UC-L", desc: "Universal RSC carton, large", style: "RSC", ply: "5", flute: "BC", L: 600, W: 400, H: 400, print: "Plain", qty: [5000, 40000], bundle: 20 },
  ],
  "Paper Bag": [
    { sku: "PB-SOS-S", desc: "Kraft SOS bag, small (bakery)", style: "Bag – SOS", ply: "Board", flute: "—", gsm: 70, L: 180, W: 110, H: 320, print: "1-colour", food: true, qty: [50000, 300000], bundle: 500 },
    { sku: "PB-SOS-L", desc: "Kraft SOS bag, large (grocery)", style: "Bag – SOS", ply: "Board", flute: "—", gsm: 90, L: 300, W: 170, H: 430, print: "1-colour", food: true, qty: [30000, 200000], bundle: 250 },
    { sku: "PB-FLAT", desc: "Flat kraft bag for takeaway", style: "Bag – flat", ply: "Board", flute: "—", gsm: 50, L: 200, W: 60, H: 300, print: "Plain", food: true, qty: [80000, 400000], bundle: 1000 },
  ],
  "Shopping Bag": [
    { sku: "SH-ROPE-M", desc: "Kraft shopping bag, twisted rope handle", style: "Bag – rope handle", ply: "Board", flute: "—", gsm: 120, L: 320, W: 110, H: 410, print: "2-colour", qty: [20000, 120000], bundle: 250, extraPkr: 6 },
    { sku: "SH-FLAT-S", desc: "White kraft bag, flat paper handle", style: "Bag – flat handle", ply: "Board", flute: "—", gsm: 100, L: 260, W: 120, H: 350, print: "4-colour", qty: [20000, 100000], bundle: 250, extraPkr: 3 },
  ],
  Beverages: [
    { sku: "CC-2", desc: "2-cup carrier, recycled board", style: "Cup carrier", ply: "Board", flute: "—", gsm: 350, L: 230, W: 120, H: 60, print: "Plain", food: true, qty: [30000, 150000], bundle: 200, extraPkr: 2 },
    { sku: "CC-4", desc: "4-cup carrier, recycled board", style: "Cup carrier", ply: "Board", flute: "—", gsm: 350, L: 230, W: 230, H: 60, print: "Plain", food: true, qty: [20000, 100000], bundle: 150, extraPkr: 3 },
    { sku: "SL-12", desc: "Cup sleeve for 12–16 oz, kraft", style: "Cup sleeve", ply: "Board", flute: "—", gsm: 250, L: 280, W: 10, H: 65, print: "1-colour", food: true, qty: [100000, 500000], bundle: 1000 },
  ],
};

const PRINT_F: Record<string, number> = { Plain: 1, "1-colour": 1.06, "2-colour": 1.12, "3-colour": 1.18, "4-colour": 1.28 };
const COAT_F: Record<string, number> = { None: 1, Wax: 1.22, "Water-resistant": 1.12, PE: 1.3, Aqueous: 1.05, Varnish: 1.06 };
const DEFECTS = ["Print registration shift up to 2 mm", "Colour slightly lighter than approved shade", "Overrun from export order, customer logo printed", "Minor edge crush on top bundles", "Dimension +3 mm on length", "Faded print on side panel"];

function prng(seedStr: string) { let h = 2166136261; for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296; }

function boardArea(line: string, L: number, W: number, H: number) {
  const l = L / 1000, w = W / 1000, h = H / 1000;
  if (/Bag/.test(line)) return (2 * (l + w) + 0.03) * (h + w * 0.75);
  if (line === "Beverages") return Math.max(l * w * 2, 0.03);
  if (line === "Pizza" || line === "Laptop") return (l + 2 * h + 0.04) * (2 * w + 3 * h + 0.04);
  return (2 * l + 2 * w + 0.04) * (w + h + 0.01);
}
function pricePkr(line: string, s: Spec) {
  const a = boardArea(line, s.L, s.W, s.H);
  let base: number;
  if (s.ply === "Board") base = a * ((s.gsm ?? 100) / 1000) * 360 + 1.2;     // paper ~PKR 360/kg + conversion
  else base = a * BOARD_PKR_PER_M2[s.ply] + 1.5;
  return base * (PRINT_F[s.print] ?? 1) * (COAT_F[s.coating ?? "None"] ?? 1) + (s.extraPkr ?? 0);
}

export function demoRows(vendorCode: string, lines: string[], location: string, certifications: string | null): Row[] {
  const rnd = prng(vendorCode);
  const rows: Row[] = [];
  for (const line of lines) {
    const specs = S[line] ?? [];
    const pick = specs.filter(() => rnd() < 0.8).slice(0, 3);
    for (const s of pick.length ? pick : specs.slice(0, 1)) {
      const second = rnd() < 0.3;
      const qty = Math.round((s.qty[0] + rnd() * (s.qty[1] - s.qty[0])) / 100) * 100;
      const pkr = pricePkr(line, s) * (second ? 0.78 : 1) * (0.92 + rnd() * 0.16);
      const withBundle = rnd() < 0.6 && s.bundle;
      const flatArea = boardArea(line, s.L, s.W, s.H) / (/Bag|Beverages|Pizza|Laptop/.test(line) ? 1 : 2);
      const thick = s.ply === "7" ? 10.5 : s.ply === "5" ? 6.6 : s.ply === "3" ? 3.6 : 0.6;
      const bL = Math.round(Math.sqrt(flatArea) * 140), bW = Math.round(Math.sqrt(flatArea) * 95), bH = withBundle ? Math.max(8, Math.round(((s.bundle as number) * thick) / 10)) : 0;
      rows.push({
        vendor_sku: `${vendorCode}-${s.sku}${second ? "-B" : ""}`, line, description: s.desc, style: s.style, choice: second ? "2nd" : "1st",
        defects: second ? DEFECTS[Math.floor(rnd() * DEFECTS.length)] : null, ply: s.ply, flute: s.flute, board: s.board ?? null, gsm: s.gsm ?? null,
        length_mm: s.L, width_mm: s.W, height_mm: s.H, dim_type: "Internal", print: s.print, coating: s.coating ?? "None", food_safe: !!s.food,
        qty, moq: Math.max(100, Math.round(qty * (0.1 + rnd() * 0.15) / 100) * 100), price: Math.round(pkr * 2) / 2, currency: "PKR",
        bundle_qty: withBundle ? s.bundle! : null, bundle_l_cm: withBundle ? bL : null, bundle_w_cm: withBundle ? bW : null, bundle_h_cm: withBundle ? bH : null,
        bundle_kg: withBundle ? Math.round(boardArea(line, s.L, s.W, s.H) * (s.ply === "Board" ? (s.gsm ?? 100) : s.ply === "7" ? 1000 : s.ply === "5" ? 700 : 430) / 1000 * (s.bundle as number) * 10) / 10 : null,
        location, lead_days: second ? 0 : Math.round(rnd() * 14), valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
        certifications, photos: rnd() < 0.5, notes: "DEMO lot — model price, replace with the vendor's real list.",
      });
    }
  }
  return rows;
}
