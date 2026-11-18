import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { PageHead, Panel, Pill, Td, Th, fmtDateTime, fmtInt, statusTone } from "@/components/console/ui";

export const metadata = { title: "Vendor" };

async function update(fd: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const submittedStatus = fd.get("status");
  const d = db();
  const changed = d.transaction(() => {
    const old = d.prepare("SELECT status FROM vendors WHERE id=?").get(id) as { status: string } | undefined;
    const status = submittedStatus === null ? old?.status ?? "" : String(submittedStatus);
    if (!old || !["prospect", "onboarding", "active", "blocked"].includes(status)) return;
    if (user.role !== "admin" && (status !== old.status || old.status === "blocked")) return;
    const email = String(fd.get("email") ?? "").trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return;
    d.prepare("UPDATE vendors SET name=?,legal_name=?,city=?,address=?,website=?,email=?,status=?,am_user_id=?,notes=? WHERE id = ?")
      .run(String(fd.get("name")).trim(), String(fd.get("legal_name") ?? "").trim() || null, String(fd.get("city")).trim(), String(fd.get("address") ?? "").trim() || null, String(fd.get("website") ?? "").trim() || null, email || null, status, Number(fd.get("am")) || null, String(fd.get("notes") ?? "") || null, id);
    if (status === "blocked") d.prepare("UPDATE items SET status = 'offline' WHERE vendor_id = ? AND status = 'online'").run(id);
    if (status !== old.status) {
      const lead = d.prepare("SELECT id FROM discovery_leads WHERE linked_vendor_id=? ORDER BY id DESC LIMIT 1").get(id) as { id: number } | undefined;
      d.prepare("INSERT INTO discovery_activity(lead_id,actor,action,detail,at) VALUES(?,?,?,?,?)")
        .run(lead?.id ?? null, user.email, "Supplier status changed", JSON.stringify({ vendor_id: id, before: old.status, after: status }), new Date().toISOString());
    }
    return true;
  })();
  if (!changed) return;
  revalidatePath(`/console/vendors/${id}`);
}

type V = { id: number; code: string; name: string; legal_name: string | null; city: string; address: string | null; website: string | null; email: string | null; phone: string | null; business_type: string; product_lines: string; evidence: string | null; export_evidence: string | null; certifications: string | null; sources: string; confidence: string | null; status: string; am_user_id: number | null; notes: string | null };

export default async function Vendor({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  const v = db().prepare("SELECT * FROM vendors WHERE id = ?").get(id) as V | undefined;
  if (!v) notFound();
  const users = db().prepare("SELECT id, name, initials FROM users WHERE active = 1 ORDER BY name").all() as { id: number; name: string; initials: string }[];
  const lots = db().prepare("SELECT line, choice, count(*) n, sum(qty) pcs FROM items WHERE vendor_id = ? AND status='online' GROUP BY line, choice ORDER BY line").all(id) as { line: string; choice: string; n: number; pcs: number }[];
  const uploads = db().prepare("SELECT id, status, rows_ok, rows_total, created_at FROM uploads WHERE vendor_id = ? ORDER BY id DESC").all(id) as { id: number; status: string; rows_ok: number; rows_total: number; created_at: string }[];
  const field = (k: string, val: React.ReactNode) => (<div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-line/70 py-2.5 text-sm last:border-0"><dt className="text-stone">{k}</dt><dd className="min-w-0 break-words">{val || <span className="text-stone">—</span>}</dd></div>);
  return (
    <>
      <p className="mb-2 text-sm text-stone"><Link href="/console/vendors" className="underline">Vendors</Link> / {v.code}</p>
      <PageHead title={v.name} sub={v.legal_name ?? undefined}>
        <Pill tone={statusTone(v.status)}>{v.status}</Pill>
        <Link href={`/console/uploads/new?vendor=${v.id}`} className="btn btn-ink !h-10">Upload a list</Link>
        <Link href={`/console/inventory?vendor=${v.id}`} className="btn btn-line !h-10 text-ink">View stock</Link>
      </PageHead>
      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Panel className="p-5">
          <dl>
            {field("City", v.city)}{field("Address", v.address)}
            {field("Website", v.website && <a href={v.website} target="_blank" rel="noreferrer" className="underline">{v.website}</a>)}
            {field("Email", v.email && <a href={`mailto:${v.email}`} className="underline">{v.email}</a>)}{field("Phone", v.phone)}
            {field("Type", v.business_type)}
            {field("Product lines", <div className="flex flex-wrap gap-1">{json<string[]>(v.product_lines, []).map((l) => <Pill key={l}>{l}</Pill>)}</div>)}
            {field("What sources confirm", v.evidence)}{field("Export evidence", v.export_evidence)}{field("Certifications", v.certifications)}
            {field("Research confidence", v.confidence && <Pill tone={v.confidence === "high" ? "good" : v.confidence === "low" ? "warn" : "info"}>{v.confidence}</Pill>)}
            {field("Sources", <ul className="space-y-1">{json<string[]>(v.sources, []).map((s) => <li key={s}><a href={s} target="_blank" rel="noreferrer" className="break-all text-[13px] underline">{s}</a></li>)}</ul>)}
          </dl>
        </Panel>
        <div className="space-y-6">
          <Panel className="p-5">
            <p className="label-mono text-stone">Account</p>
            <form action={update} className="mt-3 space-y-3">
              <input type="hidden" name="id" value={v.id} />
              <div><label className="field-label">Supplier name</label><input name="name" required defaultValue={v.name} className="field" /></div>
              <div><label className="field-label">Legal name</label><input name="legal_name" defaultValue={v.legal_name ?? ""} className="field" /></div>
              <div><label className="field-label">City</label><input name="city" required defaultValue={v.city} className="field" /></div>
              <div><label className="field-label">Address</label><input name="address" defaultValue={v.address ?? ""} className="field" /></div>
              <div><label className="field-label">Website</label><input name="website" type="url" defaultValue={v.website ?? ""} className="field" /></div>
              <div><label className="field-label">Contact email</label><input name="email" type="email" defaultValue={v.email ?? ""} className="field" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="field-label">Status</label><select name="status" aria-label="Supplier status" disabled={user.role !== "admin"} defaultValue={v.status} className="field">{["prospect", "onboarding", "active", ...(user.role === "admin" ? ["blocked"] : [])].map((s) => <option key={s}>{s}</option>)}</select></div>
                <div><label className="field-label">Account manager</label><select name="am" defaultValue={v.am_user_id ?? ""} className="field"><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
              </div>
              <div><label className="field-label">Notes</label><textarea name="notes" defaultValue={v.notes ?? ""} rows={5} className="field text-sm" /></div>
              <button className="btn btn-ink">Save</button>
              {user.role === "admin" && <p className="text-[12px] text-stone">Blocking takes all of this vendor&apos;s lots offline.</p>}
            </form>
          </Panel>
          <Panel>
            <p className="label-mono border-b border-line px-4 py-3 text-stone">Online stock</p>
            <table className="w-full"><tbody>{lots.map((l) => <tr key={l.line + l.choice}><Td>{l.line}</Td><Td><Pill tone={l.choice === "1st" ? "good" : "warn"}>{l.choice}</Pill></Td><Td className="text-right tabular-nums">{l.n} lots</Td><Td className="text-right tabular-nums">{fmtInt(l.pcs)} pcs</Td></tr>)}</tbody></table>
            {!lots.length && <p className="px-4 py-6 text-sm text-stone">No stock online.</p>}
          </Panel>
          <Panel>
            <p className="label-mono border-b border-line px-4 py-3 text-stone">Uploads</p>
            <table className="w-full"><thead><tr><Th>#</Th><Th>Status</Th><Th className="text-right">Rows</Th><Th>When</Th></tr></thead><tbody>{uploads.map((u) => <tr key={u.id}><Td><Link className="font-mono text-[12px] underline" href={`/console/uploads/${u.id}`}>U-{String(u.id).padStart(4, "0")}</Link></Td><Td><Pill tone={statusTone(u.status)}>{u.status}</Pill></Td><Td className="text-right tabular-nums">{u.rows_ok}/{u.rows_total}</Td><Td className="text-stone">{fmtDateTime(u.created_at)}</Td></tr>)}</tbody></table>
          </Panel>
        </div>
      </div>
    </>
  );
}
