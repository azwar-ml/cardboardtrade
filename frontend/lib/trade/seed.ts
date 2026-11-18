import "server-only";
import { db, getSetting, setSetting } from "./db";
import { ORIGINS, PORTS } from "./catalog";
import { hashPassword } from "./password";
import { templateWorkbook } from "./template";
import { createUpload, publishUpload, storeFile } from "./uploads";
import { DEMO_BUYERS } from "./seed/buyers";
import { demoRows } from "./seed/inventory";
import known from "./seed/vendors-known.json";
import gap from "./seed/vendors-gap.json";

type V = { name: string; legal_name: string | null; city: string; address: string | null; website: string | null; email: string | null; phone: string | null; business_type: string; product_lines: string[]; evidence: string; export_evidence: string; certifications?: string | null; sources: string[]; confidence: string; correction?: string | null };

/** Vendors that sell finished boxes/bags get a demo stock list. Mills, material suppliers and the group parent do not. */
const NO_DEMO = new Set(["Tetra Pak Pakistan", "Century Paper & Board Mills", "Mirpurkhas Sugar Mills - Paper & Board Division (MSM)", "Packages Ltd (group parent)"]);
/** Extra demo lines where research shows appliance work but no named line — flagged "capability to confirm". */
const EXTRA: Record<string, string[]> = { "UBC Convertec": ["Air Conditioners", "Iron Box"], "Roshan Packages Ltd": ["Air Conditioners"] };

let running: Promise<void> | null = null;
export function ensureSeeded() {
  if (getSetting("seeded", "") === "2") return Promise.resolve();
  running ??= seed().finally(() => { running = null; });
  return running;
}

const code = (name: string, used: Set<string>) => {
  const base = name.replace(/\(.*?\)/g, "").replace(/[^A-Za-z ]/g, "").split(/\s+/).filter((w) => !/^(the|and|of|pvt|ltd|limited|group)$/i.test(w));
  let c = (base[0] ?? "VEN").slice(0, 5).toUpperCase() + (base[1] ? base[1][0].toUpperCase() : "");
  while (used.has(c)) c = c.slice(0, 5) + String(used.size % 10);
  used.add(c);
  return c;
};
const originOf = (city: string) => Object.keys(ORIGINS).find((o) => city.includes(o)) ?? (city.includes("Mirpurkhas") ? "Hyderabad" : "Lahore");

async function seed() {
  const d = db();
  if (getSetting("seeded", "") !== "1") {
    if (process.env.NODE_ENV === "production" && !process.env.CONSOLE_ADMIN_PASSWORD) {
      throw new Error("Set CONSOLE_ADMIN_PASSWORD before first production initialization.");
    }
    d.transaction(() => {
      const users: [string, string, string, "admin" | "sales", string][] = [
        ["Admin", "admin@cardboardpackage.com", "AD", "admin", process.env.CONSOLE_ADMIN_PASSWORD ?? "admin123"],
        ["Hamza Tariq", "hamza@cardboardpackage.com", "HT", "sales", process.env.CONSOLE_SALES_PASSWORD ?? "sales123"],
        ["Sana Iqbal", "sana@cardboardpackage.com", "SI", "sales", process.env.CONSOLE_SALES_PASSWORD ?? "sales123"],
      ];
      const ins = d.prepare("INSERT OR IGNORE INTO users(name,email,initials,role,password_hash) VALUES (?,?,?,?,?)");
      for (const [n, e, i, r, p] of users) ins.run(n, e, i, r, hashPassword(p));

      for (const [k, v] of Object.entries({ fx_pkr_per_usd: "280", margin_pct: "12", fob_usd_per_cbm: "9", min_margin_usd_per_pc: "0.005" })) setSetting(k, v);
      const lane = d.prepare("INSERT OR IGNORE INTO freight_lanes(code,port,country,region,rate_40hc_usd,transit_days) VALUES (?,?,?,?,?,?)");
      for (const p of PORTS) lane.run(p.code, p.port, p.country, p.region, p.rate40, p.transit);
      const org = d.prepare("INSERT OR IGNORE INTO origins(city, inland_usd_per_cbm) VALUES (?,?)");
      for (const [c, r] of Object.entries(ORIGINS)) org.run(c, r);

      const used = new Set<string>();
      const vi = d.prepare(`INSERT INTO vendors(code,name,legal_name,city,address,website,email,phone,business_type,product_lines,evidence,export_evidence,certifications,sources,confidence,status,am_user_id,notes)
        VALUES (@code,@name,@legal_name,@city,@address,@website,@email,@phone,@business_type,@product_lines,@evidence,@export_evidence,@certifications,@sources,@confidence,'prospect',@am,@notes)`);
      const am = (i: number) => (i % 2 ? 2 : 3);
      ([...known, ...gap] as V[]).forEach((v, i) => vi.run({
        ...v, code: code(v.name, used), product_lines: JSON.stringify(v.product_lines), sources: JSON.stringify(v.sources), certifications: v.certifications ?? null, am: am(i),
        notes: [v.correction ? `Research note: ${v.correction}` : null, NO_DEMO.has(v.name) ? "Material / board source or group parent — not a box seller; no stock list." : null].filter(Boolean).join("\n") || null,
      }));

      const uid = (ini: string) => (d.prepare("SELECT id FROM users WHERE initials = ?").get(ini) as { id: number }).id;
      const bi = d.prepare("INSERT INTO buyers(name,country,city,port_code,industry,interests,choice_pref,min_order_pcs,incoterm,language,am_user_id,status,blocked_reason,is_demo,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,'DEMO buyer — fictional company for testing.')");
      const ci = d.prepare("INSERT INTO contacts(buyer_id,name,title,email,language,register,bounce,primary_contact) VALUES (?,?,?,?,?,?,?,?)");
      const ei = d.prepare("INSERT INTO buyer_events(buyer_id,kind,line,qty,at,note) VALUES (?,?,?,?,date('now', ?),'demo history')");
      for (const b of DEMO_BUYERS) {
        const id = Number(bi.run(b.name, b.country, b.city, b.port, b.industry, JSON.stringify(b.interests), b.choice, b.minPcs ?? null, b.incoterm ?? "CFR", b.contacts[0][2] ?? "EN", uid(b.am), b.status ?? "active", b.blocked ?? null).lastInsertRowid);
        const domain = b.name.toLowerCase().replace(/\(.*?\)|[^a-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 2).join("") + ".example.com";
        b.contacts.forEach(([n, t, lang, reg, bounce], k) => ci.run(id, n, t, `${n.split(" ")[0].toLowerCase()}.${n.split(" ").slice(-1)[0].toLowerCase().replace(/[^a-z]/g, "")}@${domain}`, lang ?? "EN", reg ?? "Formal", bounce ?? "none", k === 0 ? 1 : 0));
        for (const [kind, line, m, qty] of b.events ?? []) ei.run(id, kind, line, qty, `-${m} months`);
      }
      setSetting("seeded", "1");
    })();
  }

  // demo stock lists go through the real upload pipeline: raw "as sent" file + transformed template → check → publish
  const admin = (d.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() as { id: number }).id;
  const vendors = d.prepare("SELECT id, code, name, city, product_lines, certifications FROM vendors ORDER BY id").all() as { id: number; code: string; name: string; city: string; product_lines: string; certifications: string | null }[];
  for (const v of vendors) {
    if (NO_DEMO.has(v.name)) continue;
    if (d.prepare("SELECT 1 FROM uploads WHERE vendor_id = ?").get(v.id)) continue;
    const lines = [...new Set([...(JSON.parse(v.product_lines) as string[]), ...(EXTRA[v.name] ?? [])])];
    if (!lines.length) continue;
    const cert = v.certifications && /ISO|FSC|BRC|FSSC|Halal/i.test(v.certifications) ? (v.certifications.match(/ISO ?\d+|FSC|BRCGS|FSSC 22000|Halal/g) ?? []).slice(0, 3).join(", ") : null;
    const rows = demoRows(v.code, lines, originOf(v.city), cert);
    for (const r of rows) if ((EXTRA[v.name] ?? []).includes(String(r.line))) r.notes = "DEMO lot — capability for this line to be confirmed with the vendor.";
    const wb = await templateWorkbook({ vendorName: v.name, rows });
    const transformed = storeFile(Buffer.from(await wb.xlsx.writeBuffer()), `${v.code}_BULK_UPLOAD.xlsx`);
    const rawText = `From: ${v.name}\nSubject: Stock list\n\nSir, please find our available stock below:\n\n` + rows.map((r) => `${r.description} ${r.length_mm}x${r.width_mm}x${r.height_mm}mm ${r.ply === "Board" ? "" : r.ply + " ply "}— ${Number(r.qty).toLocaleString("en-US")} pcs @ Rs ${r.price}${r.choice === "2nd" ? " (B grade)" : ""}`).join("\n") + "\n\nRegards";
    const raw = storeFile(Buffer.from(rawText, "utf8"), `${v.code}_email_as_sent.txt`, "text/plain");
    const id = await createUpload({ vendorId: v.id, raw: [raw], transformed, userId: admin, note: "Demo list generated from the vendor's published product range (model prices)." });
    publishUpload(id, { replacePrevious: true, priceSource: "demo-model", keepVendorStatus: true });
  }
  setSetting("seeded", "2");
}
