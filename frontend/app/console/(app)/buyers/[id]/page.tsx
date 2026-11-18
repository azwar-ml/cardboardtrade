import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { LINES } from "@/lib/trade/catalog";
import { lanes } from "@/lib/trade/pricing";
import { PageHead, Panel, Pill, Td, Th, fmtDate, fmtDateTime, fmtInt, statusTone } from "@/components/console/ui";

export const metadata = { title: "Buyer" };

async function save(fd: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const current = db().prepare("SELECT status FROM buyers WHERE id = ?").get(id) as { status: string } | undefined;
  if (!current) return;
  if (user.role !== "admin" && (status === "blocked" || current.status === "blocked")) return;
  db().prepare("UPDATE buyers SET name=?,country=?,city=?,industry=?,port_code=?,interests=?,choice_pref=?,min_order_pcs=?,incoterm=?,status=?,blocked_reason=?,am_user_id=?,notes=? WHERE id=?")
    .run(String(fd.get("name")).trim(), String(fd.get("country")).trim(), String(fd.get("city")).trim() || null, String(fd.get("industry")).trim() || null, String(fd.get("port")), JSON.stringify(fd.getAll("interests").map(String)), String(fd.get("choice")), Number(fd.get("min")) || null, String(fd.get("incoterm")), status, status === "blocked" ? String(fd.get("reason") ?? "") || "Blocked by admin" : null, Number(fd.get("am")) || null, String(fd.get("notes") ?? "") || null, id);
  revalidatePath(`/console/buyers/${id}`);
}
async function addContact(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("id"));
  db().prepare("INSERT INTO contacts(buyer_id,name,title,email,language,register,primary_contact) VALUES (?,?,?,?,?,?,0)").run(id, String(fd.get("name")), String(fd.get("title") ?? "") || null, String(fd.get("email")), String(fd.get("lang") ?? "EN"), String(fd.get("register") ?? "Formal"));
  revalidatePath(`/console/buyers/${id}`);
}
async function updateContact(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("contact")), buyerId = Number(fd.get("buyer"));
  const name = String(fd.get("name") ?? "").trim(), email = String(fd.get("email") ?? "").trim();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return;
  db().prepare("UPDATE contacts SET name=?,email=?,language=?,register=? WHERE id=? AND buyer_id=?")
    .run(name, email, String(fd.get("language") ?? "EN"), String(fd.get("register") ?? "Formal"), id, buyerId);
  revalidatePath(`/console/buyers/${buyerId}`);
}
async function addEvent(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("id"));
  db().prepare("INSERT INTO buyer_events(buyer_id,kind,line,qty,at,note) VALUES (?,?,?,?,?,?)").run(id, String(fd.get("kind")), String(fd.get("line")), Number(fd.get("qty")) || null, String(fd.get("at")) || new Date().toISOString().slice(0, 10), String(fd.get("note") ?? "") || null);
  revalidatePath(`/console/buyers/${id}`);
}

type B = { id: number; name: string; country: string; city: string | null; port_code: string | null; industry: string | null; interests: string; choice_pref: string; min_order_pcs: number | null; incoterm: string; status: string; blocked_reason: string | null; am_user_id: number | null; notes: string | null; is_demo: number };

export default async function Buyer({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  const b = db().prepare("SELECT * FROM buyers WHERE id = ?").get(id) as B | undefined;
  if (!b) notFound();
  const contacts = db().prepare("SELECT * FROM contacts WHERE buyer_id = ? ORDER BY primary_contact DESC, id").all(id) as { id: number; name: string; title: string | null; email: string; language: string; register: string; bounce: string; primary_contact: number }[];
  const events = db().prepare("SELECT * FROM buyer_events WHERE buyer_id = ? ORDER BY at DESC").all(id) as { id: number; kind: string; line: string; qty: number | null; at: string; note: string | null }[];
  const sent = db().prepare("SELECT m.id, m.status, m.sent_at, m.subject, s.id sid, s.name FROM sendout_messages m JOIN sendouts s ON s.id = m.sendout_id WHERE m.buyer_id = ? ORDER BY m.id DESC").all(id) as { id: number; status: string; sent_at: string | null; subject: string; sid: number; name: string }[];
  const users = db().prepare("SELECT id, name FROM users WHERE active = 1").all() as { id: number; name: string }[];
  const interests = json<string[]>(b.interests, []);
  return (
    <>
      <p className="mb-2 text-sm text-stone"><Link href="/console/buyers" className="underline">Buyers</Link> / {b.name}</p>
      <PageHead title={b.name} sub={`${b.industry ?? ""} · ${b.city ? b.city + ", " : ""}${b.country}`}>{b.is_demo ? <Pill tone="muted">demo buyer</Pill> : null}<Pill tone={statusTone(b.status)}>{b.status}</Pill></PageHead>
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Panel className="p-5">
          <form action={save} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={b.id} />
            <div><label className="field-label">Company</label><input name="name" required defaultValue={b.name} className="field" /></div>
            <div><label className="field-label">Country</label><input name="country" required defaultValue={b.country} className="field" /></div>
            <div><label className="field-label">City</label><input name="city" defaultValue={b.city ?? ""} className="field" /></div>
            <div><label className="field-label">Industry</label><input name="industry" defaultValue={b.industry ?? ""} className="field" /></div>
            <div><label className="field-label">Destination port</label><select name="port" defaultValue={b.port_code ?? ""} className="field">{lanes().map((l) => <option key={l.code} value={l.code}>{l.port}, {l.country}</option>)}</select></div>
            <div><label className="field-label">Incoterm</label><select name="incoterm" defaultValue={b.incoterm} className="field"><option>CFR</option><option>FOB</option></select></div>
            <div><label className="field-label">Choice</label><select name="choice" defaultValue={b.choice_pref} className="field"><option value="mixed">Any choice</option><option value="1st">1st only</option><option value="2nd">2nd only</option></select></div>
            <div><label className="field-label">Min lot (pcs)</label><input name="min" type="number" defaultValue={b.min_order_pcs ?? ""} className="field" /></div>
            <div><label className="field-label">Status</label><select name="status" defaultValue={b.status} className="field">{["active", "prospect", ...(user.role === "admin" || b.status === "blocked" ? ["blocked"] : [])].map((s) => <option key={s}>{s}</option>)}</select></div>
            <div><label className="field-label">Block reason</label><input name="reason" defaultValue={b.blocked_reason ?? ""} className="field" /></div>
            <div><label className="field-label">Account manager</label><select name="am" defaultValue={b.am_user_id ?? ""} className="field">{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            <div><label className="field-label">Notes</label><input name="notes" defaultValue={b.notes ?? ""} className="field" /></div>
            <fieldset className="sm:col-span-2"><legend className="field-label">Buys (preference signal)</legend><div className="flex flex-wrap gap-2">{LINES.map((l) => <label key={l} className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm ring-1 ring-line"><input type="checkbox" name="interests" value={l} defaultChecked={interests.includes(l)} className="accent-accent" />{l}</label>)}</div></fieldset>
            <div className="sm:col-span-2"><button className="btn btn-ink">Save</button></div>
          </form>
        </Panel>
        <div className="space-y-6">
          <Panel>
            <p className="label-mono border-b border-line px-4 py-3 text-stone">Contacts</p>
            <table className="w-full"><tbody>{contacts.map((c) => <tr key={c.id}><Td>{c.title ? c.title + " " : ""}{c.name}{c.primary_contact ? <span className="ml-1"><Pill tone="muted">primary</Pill></span> : null}<span className="block text-[12px] text-stone">{c.email}</span></Td><Td>{c.language} · {c.register}</Td><Td>{c.bounce !== "none" ? <Pill tone={c.bounce === "hard" ? "bad" : "warn"}>{c.bounce} bounce</Pill> : null}</Td></tr>)}</tbody></table>
            <div className="space-y-2 border-t border-line p-4">{contacts.map((c) => <form key={`edit-${c.id}`} action={updateContact} className="grid grid-cols-2 gap-2 rounded border border-line p-2">
              <input type="hidden" name="contact" value={c.id} /><input type="hidden" name="buyer" value={b.id} />
              <input aria-label="Contact name" name="name" required defaultValue={c.name} className="field text-sm" /><input aria-label="Contact email" name="email" type="email" required defaultValue={c.email} className="field text-sm" />
              <select aria-label="Language" name="language" defaultValue={c.language} className="field text-sm">{["EN", "DE", "FR", "AR"].map((l) => <option key={l}>{l}</option>)}</select>
              <div className="flex gap-2"><select aria-label="Register" name="register" defaultValue={c.register} className="field text-sm"><option>Formal</option><option>Informal</option></select><button className="btn btn-line !h-9 text-sm text-ink">Save contact</button></div>
            </form>)}</div>
            <form action={addContact} className="grid grid-cols-2 gap-2 border-t border-line p-4">
              <input type="hidden" name="id" value={b.id} />
              <input name="name" required placeholder="Name" className="field text-sm" /><input name="email" type="email" required placeholder="Email" className="field text-sm" />
              <select name="title" className="field text-sm"><option value="">Title</option><option>Mr.</option><option>Ms.</option></select>
              <div className="flex gap-2"><select name="lang" className="field text-sm">{["EN", "DE", "FR", "AR"].map((l) => <option key={l}>{l}</option>)}</select><select name="register" className="field text-sm"><option>Formal</option><option>Informal</option></select></div>
              <button className="btn btn-line col-span-2 !h-10 text-ink">Add contact</button>
            </form>
          </Panel>
          <Panel>
            <p className="label-mono border-b border-line px-4 py-3 text-stone">Purchase & RFQ history (drives matching signals)</p>
            <table className="w-full"><tbody>{events.map((e) => <tr key={e.id}><Td><Pill tone={e.kind === "purchase" ? "good" : "info"}>{e.kind}</Pill></Td><Td>{e.line}</Td><Td className="text-right tabular-nums">{fmtInt(e.qty)} pcs</Td><Td className="text-stone">{fmtDate(e.at)}</Td></tr>)}</tbody></table>
            <form action={addEvent} className="grid grid-cols-2 gap-2 border-t border-line p-4">
              <input type="hidden" name="id" value={b.id} />
              <select name="kind" className="field text-sm"><option value="purchase">Purchase</option><option value="rfq">RFQ</option></select>
              <select name="line" className="field text-sm">{LINES.map((l) => <option key={l}>{l}</option>)}</select>
              <input name="qty" type="number" placeholder="Qty pcs" className="field text-sm" /><input name="at" type="date" className="field text-sm" />
              <button className="btn btn-line col-span-2 !h-10 text-ink">Log event</button>
            </form>
          </Panel>
          <Panel>
            <p className="label-mono border-b border-line px-4 py-3 text-stone">Sendouts received</p>
            <table className="w-full"><thead><tr><Th>Sendout</Th><Th>Status</Th><Th>Sent</Th></tr></thead><tbody>{sent.map((m) => <tr key={m.id}><Td><Link href={`/console/sendouts/${m.sid}/send`} className="underline">{m.name}</Link></Td><Td><Pill tone={statusTone(m.status)}>{m.status}</Pill></Td><Td className="text-stone">{fmtDateTime(m.sent_at)}</Td></tr>)}</tbody></table>
            {!sent.length && <p className="px-4 py-5 text-sm text-stone">Nothing sent yet.</p>}
          </Panel>
        </div>
      </div>
    </>
  );
}
