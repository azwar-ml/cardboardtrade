import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { optionsOf } from "@/lib/trade/mail";
import { getSendout, messages, sendAll } from "@/lib/trade/sendout";
import { PageHead, Panel, Pill, Td, Th, fmtDateTime, statusTone } from "@/components/console/ui";
import Steps from "@/components/console/Steps";
import SendButton from "@/components/console/SendButton";

export const metadata = { title: "Send" };

async function send(fd: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(fd.get("id"));
  await sendAll(id, user.id);
  redirect(`/console/sendouts/${id}/send`);
}
async function reply(fd: FormData) {
  "use server";
  await requireUser();
  db().prepare("UPDATE sendout_messages SET status = 'replied', reply_note = ? WHERE id = ?").run(String(fd.get("note") ?? "") || "Replied", Number(fd.get("mid")));
  revalidatePath(`/console/sendouts/${fd.get("id")}/send`);
}

export default async function Send({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const id = Number((await params).id);
  const s = getSendout(id);
  if (!s) notFound();
  const msgs = messages(id);
  const o = optionsOf(s.options);
  const sender = db().prepare("SELECT name FROM users WHERE id = ?").get(s.sender_id) as { name: string } | undefined;
  const smtp = false;
  const sent = s.status === "sent";
  const counts = msgs.reduce<Record<string, number>>((a, m) => ((a[m.status] = (a[m.status] ?? 0) + 1), a), {});
  return (
    <>
      <PageHead title={s.name ?? "Sendout"} sub={sent ? `Sent ${fmtDateTime(s.sent_at)} by ${sender?.name ?? "—"}` : "Final check before sending."}>{sent && <Pill tone="good">sent</Pill>}</PageHead>
      <Steps active={3} id={id} locked={sent} />
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Panel className="p-4"><p className="font-display text-2xl">{msgs.length}</p><p className="label-mono text-stone">Emails</p></Panel>
        <Panel className="p-4"><p className="font-display text-2xl">{o.attachList ? "Excel" : "None"}</p><p className="label-mono text-stone">Attachment</p></Panel>
        <Panel className="p-4"><p className="font-display text-2xl">{o.includePrice ? (o.incoterm === "CFR" ? "CFR" : "FOB") : "Offer"}</p><p className="label-mono text-stone">Price basis</p></Panel>
        <Panel className="p-4"><p className="font-display text-2xl">{smtp ? "SMTP" : "Outbox"}</p><p className="label-mono text-stone">Delivery</p></Panel>
      </div>
      {!smtp && <p className="mb-6 rounded-[6px] border border-line bg-paper px-4 py-3 text-sm text-stone"><strong className="text-ink">Draft-only mode.</strong> Email messages are written to the local outbox for review and are never sent to recipients.</p>}

      <Panel className="overflow-x-auto">
        <table className="w-full">
          <thead><tr><Th>Company</Th><Th>To</Th><Th>Subject</Th><Th className="text-right">Positions</Th><Th>Status</Th>{sent && <><Th>Sent</Th><Th>Files</Th><Th>Reply</Th></>}</tr></thead>
          <tbody>{msgs.map((m) => (
            <tr key={m.id}>
              <Td className="font-medium">{m.buyer}</Td><Td>{m.contact}<span className="block text-[12px] text-stone">{m.email}</span></Td>
              <Td className="max-w-[26rem] truncate" title={m.subject}>{m.subject}</Td><Td className="text-right tabular-nums">{json<number[]>(m.item_ids, []).length}</Td>
              <Td><Pill tone={statusTone(m.status)}>{m.status === "outbox" ? "in outbox" : m.status}</Pill>{m.error && <span className="block text-[12px] text-accent-deep">{m.error}</span>}</Td>
              {sent && <>
                <Td className="text-stone">{fmtDateTime(m.sent_at)}</Td>
                <Td>{m.eml_path && <a className="underline" href={`/api/console/files/outbox/${m.eml_path}`}>.eml</a>}{m.attachment && <> · <a className="underline" href={`/api/console/files/${m.attachment}`}>.xlsx</a></>}</Td>
                <Td>{m.status === "replied" ? <span className="text-sm">{m.reply_note}</span> : (
                  <form action={reply} className="flex gap-1"><input type="hidden" name="id" value={id} /><input type="hidden" name="mid" value={m.id} /><input name="note" placeholder="Bid / note" className="field !min-h-[32px] !w-36 !py-1 text-[12px]" /><button className="text-[12px] underline">Log reply</button></form>
                )}</Td>
              </>}
            </tr>))}</tbody>
        </table>
      </Panel>
      <div className="sticky bottom-0 mt-6 flex items-center justify-between gap-4 border-t border-line bg-bone/95 py-4 backdrop-blur">
        <span className="text-sm text-stone">{sent ? Object.entries(counts).map(([k, v]) => `${v} ${k === "outbox" ? "in outbox" : k}`).join(" · ") : `${msgs.length} emails ready, sending as ${sender?.name ?? "—"}`}</span>
        {sent ? <Link href="/console/sendouts" className="btn btn-ink">Back to tracking</Link> : (
          <span className="flex gap-2"><Link href={`/console/sendouts/${id}/compose`} className="btn btn-line text-ink">Back</Link><form action={send}><input type="hidden" name="id" value={id} /><SendButton n={msgs.length} smtp={smtp} /></form></span>
        )}
      </div>
    </>
  );
}
