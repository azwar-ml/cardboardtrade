import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { optionsOf } from "@/lib/trade/mail";
import { portByCode } from "@/lib/trade/catalog";
import { generateMessages, getSendout, messages, sendTest } from "@/lib/trade/sendout";
import { PageHead, Panel, Pill } from "@/components/console/ui";
import Steps from "@/components/console/Steps";

export const metadata = { title: "Compose & review" };

async function saveBase(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("id"));
  const force = fd.get("force") === "1";
  const options = { includePrice: fd.get("includePrice") === "on", attachList: fd.get("attachList") === "on", pickedForYou: fd.get("pickedForYou") === "on", minLotPcs: Number(fd.get("minLot")) || null, incoterm: String(fd.get("incoterm")) === "FOB" ? "FOB" : "CFR" };
  db().prepare("UPDATE sendouts SET name = ?, subject = ?, body = ?, options = ?, sender_id = ? WHERE id = ? AND status = 'draft'")
    .run(String(fd.get("name") ?? ""), String(fd.get("subject") ?? ""), String(fd.get("body") ?? ""), JSON.stringify(options), Number(fd.get("sender")), id);
  generateMessages(id, force);
  revalidatePath(`/console/sendouts/${id}/compose`);
}
async function saveMessage(fd: FormData) {
  "use server";
  await requireUser();
  db().prepare("UPDATE sendout_messages SET subject = ?, body = ?, overridden = 1 WHERE id = ? AND status = 'queued'").run(String(fd.get("subject")), String(fd.get("body")), Number(fd.get("mid")));
  revalidatePath(`/console/sendouts/${fd.get("id")}/compose`);
}
async function removeMessage(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("id")), buyer = Number(fd.get("buyer"));
  const s = getSendout(id)!;
  const ex = new Set(json<number[]>(s.excluded_buyer_ids, [])); ex.add(buyer);
  db().prepare("UPDATE sendouts SET excluded_buyer_ids = ? WHERE id = ?").run(JSON.stringify([...ex]), id);
  db().prepare("DELETE FROM sendout_messages WHERE sendout_id = ? AND buyer_id = ?").run(id, buyer);
  revalidatePath(`/console/sendouts/${id}/compose`);
}
async function test(fd: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const r = await sendTest(id, user);
  redirect(`/console/sendouts/${id}/compose?test=${encodeURIComponent(r.eml ?? "smtp")}`);
}

export default async function Compose({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ test?: string }> }) {
  await requireUser();
  const id = Number((await params).id);
  const { test: testFile } = await searchParams;
  const s = getSendout(id);
  if (!s) notFound();
  if (s.status === "sent") redirect(`/console/sendouts/${id}/send`);
  let msgs = messages(id);
  if (!msgs.length && !json<number[]>(s.excluded_buyer_ids, []).length) { generateMessages(id); msgs = messages(id); }
  const o = optionsOf(s.options);
  const users = db().prepare("SELECT id, name, initials FROM users WHERE active = 1 ORDER BY name").all() as { id: number; name: string; initials: string }[];
  const sender = users.find((u) => u.id === s.sender_id);
  const langs = new Set(msgs.map((m) => m.language));
  const tog = (name: string, label: string, hint: string, on: boolean) => (
    <label className="flex items-center justify-between gap-4 py-2"><span><span className="block text-sm">{label}</span><span className="text-[12px] text-stone">{hint}</span></span><input type="checkbox" name={name} defaultChecked={on} className="size-5 accent-accent" /></label>
  );
  return (
    <>
      <PageHead title="Buyer Sendouts" />
      <Steps active={2} id={id} />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[[msgs.length, "Emails"], [langs.size, "Languages"], [o.attachList ? "Excel" : "None", "Attachment"], [sender?.initials ?? "—", "Sending as"]].map(([v, l]) => <Panel key={String(l)} className="p-4"><p className="font-display text-2xl">{v}</p><p className="label-mono text-stone">{l}</p></Panel>)}
      </div>
      {testFile && <p className="mb-4 rounded-[6px] bg-[#e6f2ea] px-4 py-3 text-sm text-[#1f6b3a]">Test email written. {testFile !== "smtp" ? <a className="underline" href={`/api/console/files/outbox/${testFile}`}>Download the .eml</a> : "Sent through SMTP."}</p>}

      <div className="grid gap-6 xl:grid-cols-[24rem_1fr]">
        <Panel className="self-start p-5">
          <form action={saveBase} className="space-y-3">
            <input type="hidden" name="id" value={id} />
            <p className="font-medium">Message</p>
            <div><label className="field-label">Sendout name</label><input name="name" defaultValue={s.name ?? ""} className="field text-sm" /><p className="mt-1 text-[12px] text-stone">How it appears in Tracking. Internal only.</p></div>
            <div><label className="field-label">Subject (base EN)</label><input name="subject" defaultValue={s.subject ?? ""} className="field text-sm" /></div>
            <div><label className="field-label">Body (base EN, no greeting)</label><textarea name="body" defaultValue={s.body ?? ""} rows={12} className="field text-[13px] leading-relaxed" />
              <p className="mt-1 text-[12px] leading-relaxed text-stone">Variables: {"{week} {lines} {count} {pcs} {origins} {priceLine} {company}"}. Greeting and sign-off are added per recipient in their language and register.</p></div>
            <div className="border-t border-line pt-2">
              <p className="label-mono pt-1 text-stone">Options</p>
              {tog("includePrice", "Include price", "Off: every row reads Make best offer", o.includePrice)}
              {tog("attachList", "Attach material list", "Excel per buyer, priced to their port", o.attachList)}
              {tog("pickedForYou", "Add “picked for you” line", "Mentions their purchase / RFQ history", o.pickedForYou)}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div><label className="field-label">Price basis</label><select name="incoterm" defaultValue={o.incoterm} className="field text-sm"><option value="CFR">CFR buyer port</option><option value="FOB">FOB Karachi</option></select></div>
                <div><label className="field-label">Min lot pcs</label><input name="minLot" type="number" defaultValue={o.minLotPcs ?? ""} placeholder="none" className="field text-sm" /></div>
              </div>
              <div className="pt-3"><label className="field-label">Send as</label><select name="sender" defaultValue={s.sender_id ?? ""} className="field text-sm">{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <button className="btn btn-ink !h-10">Save & update emails</button>
              <button name="force" value="1" className="btn btn-line !h-10 text-ink" title="Also overwrites emails you edited by hand">Regenerate all</button>
            </div>
          </form>
        </Panel>

        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-stone">{msgs.length} emails · {langs.size} language{langs.size !== 1 ? "s" : ""} ({[...langs].join(", ")}) · {o.attachList ? "1 Excel attachment each" : "no attachment"}</p>
            <form action={test}><input type="hidden" name="id" value={id} /><button className="btn btn-line !h-9 text-sm text-ink" disabled={!msgs.length}>Send test to me</button></form>
          </div>
          <div className="space-y-4">
            {msgs.map((m) => {
              const items = json<number[]>(m.item_ids, []).length;
              const port = portByCode(m.port_code);
              return (
                <Panel key={m.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
                    <span className="flex items-center gap-2"><span className="font-medium">{m.buyer}</span><span className="text-sm text-stone">{m.country}</span>{m.am && <Pill>{m.am}</Pill>}<Pill tone="muted">score {m.score}</Pill>{m.overridden ? <Pill tone="warn">edited</Pill> : null}</span>
                    <form action={removeMessage}><input type="hidden" name="id" value={id} /><input type="hidden" name="buyer" value={m.buyer_id} /><button className="text-sm underline">Remove</button></form>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[13px] text-stone">To: <span className="text-ink">{m.contact} &lt;{m.email}&gt;</span> · From: {sender?.name} · Cardboard Package <span className="ml-1"><Pill>{m.language}</Pill></span> <Pill>{m.register}</Pill>{m.bounce === "soft" && <span className="ml-1"><Pill tone="warn">soft bounce</Pill></span>}</p>
                    <p className="mt-3 font-medium">{m.subject}</p>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink/90">{m.body}</pre>
                    {o.attachList && <p className="mt-3 inline-flex items-center gap-2 rounded-[6px] bg-bone px-3 py-2 text-[13px]">📎 CP_material_list.xlsx · {items} positions · {o.includePrice ? (o.incoterm === "CFR" && port ? `CFR ${port.port}` : "FOB Karachi") : "make best offer"}</p>}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm underline">Edit this email</summary>
                      <form action={saveMessage} className="mt-3 space-y-2">
                        <input type="hidden" name="id" value={id} /><input type="hidden" name="mid" value={m.id} />
                        <input name="subject" defaultValue={m.subject} className="field text-sm" />
                        <textarea name="body" defaultValue={m.body} rows={12} className="field text-[13px]" />
                        <button className="btn btn-ink !h-9 text-sm">Save this email</button>
                      </form>
                    </details>
                  </div>
                </Panel>
              );
            })}
            {!msgs.length && <Panel className="p-10 text-center text-stone">No emails. <Link className="underline" href={`/console/sendouts/${id}/buyers`}>Go back and include buyers.</Link></Panel>}
          </div>
        </div>
      </div>
      <div className="sticky bottom-0 mt-6 flex items-center justify-between gap-4 border-t border-line bg-bone/95 py-4 backdrop-blur">
        <span className="text-sm text-stone">{msgs.length} contacts · {new Set(msgs.map((m) => m.buyer_id)).size} companies</span>
        <span className="flex gap-2"><Link href={`/console/sendouts/${id}/buyers`} className="btn btn-line text-ink">Back</Link>{msgs.length > 0 && <Link href={`/console/sendouts/${id}/send`} className="btn btn-ink">Review & send</Link>}</span>
      </div>
    </>
  );
}
