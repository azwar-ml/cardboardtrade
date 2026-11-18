import Link from "next/link";
import { redirect } from "next/navigation";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { LINES } from "@/lib/trade/catalog";
import { lanes } from "@/lib/trade/pricing";
import { PageHead, Panel, Pill, Td, Th, statusTone } from "@/components/console/ui";

export const metadata = { title: "Buyers" };

async function addBuyer(fd: FormData) {
  "use server";
  const user = await requireUser();
  const g = (k: string) => String(fd.get(k) ?? "").trim();
  if (!g("name") || !g("contact") || !g("email")) return;
  const d = db();
  const id = d.transaction(() => {
    const port = d.prepare("SELECT country FROM freight_lanes WHERE code = ?").get(g("port")) as { country: string } | undefined;
    const r = d.prepare("INSERT INTO buyers(name,country,city,port_code,industry,interests,choice_pref,min_order_pcs,incoterm,language,am_user_id,status,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',0)")
      .run(g("name"), port?.country ?? "", g("city") || null, g("port") || null, g("industry") || null, JSON.stringify(fd.getAll("interests").map(String)), g("choice") || "mixed", Number(g("min")) || null, g("incoterm") || "CFR", g("lang") || "EN", user.id);
    d.prepare("INSERT INTO contacts(buyer_id,name,title,email,language,register) VALUES (?,?,?,?,?,?)").run(r.lastInsertRowid, g("contact"), g("title") || null, g("email"), g("lang") || "EN", g("register") || "Formal");
    return Number(r.lastInsertRowid);
  })();
  redirect(`/console/buyers/${id}`);
}

type B = { id: number; name: string; country: string; city: string | null; port: string | null; industry: string | null; interests: string; choice_pref: string; status: string; is_demo: number; am: string | null; contacts: number; bounced: number; events: number; last_sent: string | null };

export default async function Buyers({ searchParams }: { searchParams: Promise<{ q?: string; line?: string; add?: string }> }) {
  await requireUser();
  const f = await searchParams;
  let rows = db().prepare(`SELECT b.*, fl.port, u.initials am, (SELECT count(*) FROM contacts c WHERE c.buyer_id=b.id) contacts, (SELECT count(*) FROM contacts c WHERE c.buyer_id=b.id AND c.bounce!='none') bounced,
    (SELECT count(*) FROM buyer_events e WHERE e.buyer_id=b.id) events, (SELECT max(sent_at) FROM sendout_messages m WHERE m.buyer_id=b.id AND m.status IN ('sent','outbox','replied')) last_sent
    FROM buyers b LEFT JOIN freight_lanes fl ON fl.code=b.port_code LEFT JOIN users u ON u.id=b.am_user_id ORDER BY b.name`).all() as B[];
  if (f.q) rows = rows.filter((r) => (r.name + r.country + (r.city ?? "")).toLowerCase().includes(f.q!.toLowerCase()));
  if (f.line) rows = rows.filter((r) => json<string[]>(r.interests, []).includes(f.line!));
  return (
    <>
      <PageHead title="Buyers" sub={`${rows.length} buyer companies. Demo buyers are fictional and use example.com addresses.`}><Link href="?add=1" className="btn btn-ink !h-10">Add buyer</Link></PageHead>
      {f.add && (
        <Panel className="mb-4 p-5">
          <form action={addBuyer} className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-2"><label className="field-label">Company</label><input name="name" required className="field" /></div>
            <div><label className="field-label">Destination port</label><select name="port" className="field">{lanes().map((l) => <option key={l.code} value={l.code}>{l.port}, {l.country}</option>)}</select></div>
            <div><label className="field-label">City</label><input name="city" className="field" /></div>
            <div><label className="field-label">Industry</label><input name="industry" className="field" /></div>
            <div><label className="field-label">Choice</label><select name="choice" className="field"><option value="mixed">Any choice</option><option value="1st">1st only</option><option value="2nd">2nd only</option></select></div>
            <div><label className="field-label">Min lot (pcs)</label><input name="min" type="number" className="field" /></div>
            <div><label className="field-label">Incoterm</label><select name="incoterm" className="field"><option>CFR</option><option>FOB</option></select></div>
            <div><label className="field-label">Contact name</label><input name="contact" required className="field" /></div>
            <div><label className="field-label">Title</label><select name="title" className="field"><option value="">—</option><option>Mr.</option><option>Ms.</option></select></div>
            <div><label className="field-label">Email</label><input name="email" type="email" required className="field" /></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="field-label">Language</label><select name="lang" className="field">{["EN", "DE", "FR", "AR"].map((l) => <option key={l}>{l}</option>)}</select></div><div><label className="field-label">Register</label><select name="register" className="field"><option>Formal</option><option>Informal</option></select></div></div>
            <fieldset className="md:col-span-4"><legend className="field-label">Buys</legend><div className="flex flex-wrap gap-2">{LINES.map((l) => <label key={l} className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm ring-1 ring-line"><input type="checkbox" name="interests" value={l} className="accent-accent" />{l}</label>)}</div></fieldset>
            <div className="flex gap-2 md:col-span-4"><button className="btn btn-ink">Save buyer</button><Link href="/console/buyers" className="btn btn-line text-ink">Cancel</Link></div>
          </form>
        </Panel>
      )}
      <Panel className="mb-4 p-3">
        <form className="flex flex-wrap gap-2">
          <input name="q" defaultValue={f.q} placeholder="Search company or country" className="field !min-h-[38px] !w-56 !py-1.5 text-sm" />
          <select name="line" defaultValue={f.line ?? ""} className="field !min-h-[38px] !w-auto !py-1.5 text-sm"><option value="">Buys anything</option>{LINES.map((l) => <option key={l}>{l}</option>)}</select>
          <button className="btn btn-ink !h-[38px] !px-4 text-sm">Apply</button>
        </form>
      </Panel>
      <Panel className="overflow-x-auto">
        <table className="w-full">
          <thead><tr><Th>Company</Th><Th>Country</Th><Th>Port</Th><Th>Buys</Th><Th>Choice</Th><Th>Contacts</Th><Th>History</Th><Th>Last sendout</Th><Th>AM</Th><Th>Status</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="hover:bg-bone/60">
              <Td><Link href={`/console/buyers/${r.id}`} className="font-medium hover:underline">{r.name}</Link>{r.is_demo ? <span className="ml-2"><Pill tone="muted">demo</Pill></span> : null}<span className="block text-[12px] text-stone">{r.industry}</span></Td>
              <Td>{r.country}</Td><Td>{r.port ?? "—"}</Td>
              <Td className="max-w-[20rem] whitespace-normal"><div className="flex flex-wrap gap-1">{json<string[]>(r.interests, []).map((l) => <Pill key={l}>{l}</Pill>)}</div></Td>
              <Td>{r.choice_pref === "mixed" ? "Any" : r.choice_pref}</Td>
              <Td>{r.contacts}{r.bounced ? <span className="ml-1"><Pill tone="warn">{r.bounced} bounce</Pill></span> : null}</Td>
              <Td>{r.events ? `${r.events} events` : "—"}</Td><Td className="text-stone">{r.last_sent?.slice(0, 10) ?? "—"}</Td><Td>{r.am ?? "—"}</Td>
              <Td><Pill tone={statusTone(r.status)}>{r.status}</Pill></Td>
            </tr>))}</tbody>
        </table>
      </Panel>
    </>
  );
}
