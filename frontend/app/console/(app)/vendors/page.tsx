import Link from "next/link";
import { redirect } from "next/navigation";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { LINES, ORIGIN_CITIES } from "@/lib/trade/catalog";
import { PageHead, Panel, Pill, Td, Th, fmtInt, statusTone } from "@/components/console/ui";

export const metadata = { title: "Vendors" };

async function addVendor(fd: FormData) {
  "use server";
  await requireUser();
  const name = String(fd.get("name") ?? "").trim();
  if (!name) return;
  const lines = fd.getAll("lines").map(String);
  const code = name.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() + Math.floor(Math.random() * 90 + 10);
  const r = db().prepare("INSERT INTO vendors(code,name,city,website,email,phone,business_type,product_lines,status,notes) VALUES (?,?,?,?,?,?,?,?,'prospect',?)")
    .run(code, name, String(fd.get("city") ?? ""), String(fd.get("website") ?? "") || null, String(fd.get("email") ?? "") || null, String(fd.get("phone") ?? "") || null, String(fd.get("type") ?? "manufacturer"), JSON.stringify(lines), String(fd.get("notes") ?? "") || null);
  redirect(`/console/vendors/${r.lastInsertRowid}`);
}

type V = { id: number; code: string; name: string; city: string; business_type: string; product_lines: string; confidence: string | null; status: string; website: string | null; am: string | null; online: number; pcs: number | null };

export default async function Vendors({ searchParams }: { searchParams: Promise<{ q?: string; line?: string; status?: string; conf?: string; add?: string }> }) {
  await requireUser();
  const f = await searchParams;
  let rows = db().prepare(`SELECT v.id, v.code, v.name, v.city, v.business_type, v.product_lines, v.confidence, v.status, v.website, u.initials am,
    (SELECT count(*) FROM items i WHERE i.vendor_id = v.id AND i.status='online') online, (SELECT sum(qty) FROM items i WHERE i.vendor_id = v.id AND i.status='online') pcs
    FROM vendors v LEFT JOIN users u ON u.id = v.am_user_id ORDER BY v.name`).all() as V[];
  if (f.q) rows = rows.filter((r) => (r.name + r.city).toLowerCase().includes(f.q!.toLowerCase()));
  if (f.line) rows = rows.filter((r) => json<string[]>(r.product_lines, []).includes(f.line!));
  if (f.status) rows = rows.filter((r) => r.status === f.status);
  if (f.conf) rows = rows.filter((r) => r.confidence === f.conf);
  const sel = "field !min-h-[38px] !w-auto !py-1.5 text-sm";
  return (
    <>
      <PageHead title="Vendors" sub={`${rows.length} Pakistani packaging vendors. Contact details and product lines are from public sources — verify before quoting.`}>
        <Link href="?add=1" className="btn btn-ink !h-10">Add vendor</Link>
      </PageHead>

      {f.add && (
        <Panel className="mb-4 p-5">
          <form action={addVendor} className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-2"><label className="field-label">Company name</label><input name="name" required className="field" /></div>
            <div><label className="field-label">City</label><select name="city" className="field">{ORIGIN_CITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div><label className="field-label">Type</label><select name="type" className="field">{["manufacturer", "converter", "mill", "trader"].map((c) => <option key={c}>{c}</option>)}</select></div>
            <div><label className="field-label">Website</label><input name="website" className="field" /></div>
            <div><label className="field-label">Email</label><input name="email" type="email" className="field" /></div>
            <div><label className="field-label">Phone / WhatsApp</label><input name="phone" className="field" /></div>
            <div><label className="field-label">Notes</label><input name="notes" className="field" /></div>
            <fieldset className="md:col-span-4"><legend className="field-label">Product lines</legend><div className="flex flex-wrap gap-2">{LINES.map((l) => <label key={l} className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm ring-1 ring-line"><input type="checkbox" name="lines" value={l} className="accent-accent" />{l}</label>)}</div></fieldset>
            <div className="flex gap-2 md:col-span-4"><button className="btn btn-ink">Save vendor</button><Link href="/console/vendors" className="btn btn-line text-ink">Cancel</Link></div>
          </form>
        </Panel>
      )}

      <Panel className="mb-4 p-3">
        <form className="flex flex-wrap gap-2">
          <input name="q" defaultValue={f.q} placeholder="Search name or city" className="field !min-h-[38px] !w-56 !py-1.5 text-sm" />
          <select name="line" defaultValue={f.line ?? ""} className={sel}><option value="">Any product line</option>{LINES.map((l) => <option key={l}>{l}</option>)}</select>
          <select name="status" defaultValue={f.status ?? ""} className={sel}><option value="">Any status</option>{["prospect", "onboarding", "active", "blocked"].map((s) => <option key={s}>{s}</option>)}</select>
          <select name="conf" defaultValue={f.conf ?? ""} className={sel}><option value="">Any confidence</option>{["high", "medium", "low"].map((s) => <option key={s}>{s}</option>)}</select>
          <button className="btn btn-ink !h-[38px] !px-4 text-sm">Apply</button><Link href="/console/vendors" className="self-center px-2 text-sm text-stone">Reset</Link>
        </form>
      </Panel>

      <Panel className="overflow-x-auto">
        <table className="w-full">
          <thead><tr><Th>Code</Th><Th>Vendor</Th><Th>City</Th><Th>Type</Th><Th>Product lines</Th><Th>Research</Th><Th>Status</Th><Th className="text-right">Lots online</Th><Th className="text-right">Pieces</Th><Th>AM</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="hover:bg-bone/60">
              <Td className="font-mono text-[12px]">{r.code}</Td>
              <Td><Link href={`/console/vendors/${r.id}`} className="font-medium hover:underline">{r.name}</Link>{r.website && <a href={r.website} target="_blank" rel="noreferrer" className="block text-[12px] text-stone hover:underline">{r.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>}</Td>
              <Td>{r.city}</Td><Td>{r.business_type}</Td>
              <Td className="max-w-[24rem] whitespace-normal"><div className="flex flex-wrap gap-1">{json<string[]>(r.product_lines, []).map((l) => <Pill key={l}>{l}</Pill>)}{!json<string[]>(r.product_lines, []).length && <span className="text-[12px] text-stone">No matching line confirmed</span>}</div></Td>
              <Td><Pill tone={r.confidence === "high" ? "good" : r.confidence === "low" ? "warn" : "info"}>{r.confidence ?? "—"}</Pill></Td>
              <Td><Pill tone={statusTone(r.status)}>{r.status}</Pill></Td>
              <Td className="text-right tabular-nums">{r.online || "—"}</Td><Td className="text-right tabular-nums">{r.pcs ? fmtInt(r.pcs) : "—"}</Td><Td>{r.am ?? "—"}</Td>
            </tr>))}</tbody>
        </table>
      </Panel>
    </>
  );
}
