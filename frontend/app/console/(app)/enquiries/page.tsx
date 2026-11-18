import Link from "next/link";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { PageHead, Panel, Td, Th, fmtDateTime } from "@/components/console/ui";

export const metadata = { title: "Enquiries" };

type Enquiry = { id: string; received_at: string; subject: string | null; first_name: string; last_name: string; email: string; phone: string | null; company: string; country: string; product: string | null; quantity: string | null; message: string; attachments: string };

export default async function Enquiries() {
  await requireUser();
  const rows = db().prepare("SELECT * FROM enquiries ORDER BY received_at DESC LIMIT 250").all() as Enquiry[];
  return <>
    <PageHead title="Enquiries" sub="Website enquiries saved transactionally for operator follow-up." />
    <Panel className="overflow-x-auto">
      <table className="w-full text-left"><thead><tr><Th>Received</Th><Th>Contact</Th><Th>Company</Th><Th>Request</Th><Th>Message</Th><Th>Files</Th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <Td className="whitespace-nowrap">{fmtDateTime(r.received_at)}<span className="block font-mono text-[10px] text-stone">{r.id}</span></Td>
          <Td>{r.first_name} {r.last_name}<a className="block text-sm underline" href={`mailto:${r.email}`}>{r.email}</a>{r.phone && <span className="block text-xs text-stone">{r.phone}</span>}</Td>
          <Td>{r.company}<span className="block text-xs text-stone">{r.country}</span></Td>
          <Td>{r.product || "—"}<span className="block text-xs text-stone">{r.quantity || "Quantity not specified"}</span></Td>
          <Td className="max-w-sm whitespace-pre-wrap text-sm">{r.message}{r.subject && <span className="mt-1 block text-xs text-stone">Subject: {r.subject}</span>}</Td>
          <Td>{json<string[]>(r.attachments, []).map((f) => <Link key={f} className="block text-sm underline" href={`/api/console/files/${f.split("/").map(encodeURIComponent).join("/")}`}>{f.split("/").at(-1)}</Link>)}</Td>
        </tr>)}</tbody></table>
      {!rows.length && <p className="p-8 text-center text-sm text-stone">No website enquiries have arrived yet.</p>}
    </Panel>
  </>;
}
