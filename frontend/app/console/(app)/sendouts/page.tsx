import Link from "next/link";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { PageHead, Panel, Pill, Td, Th, fmtDateTime, statusTone } from "@/components/console/ui";

export const metadata = { title: "Sendout Tracking" };

export default async function Tracking({ searchParams }: { searchParams: Promise<{ status?: string; buyer?: string; from?: string; to?: string }> }) {
  await requireUser();
  const f = await searchParams;
  const status = ["draft", "sent", "failed"].includes(f.status ?? "") ? f.status! : "";
  const buyer = (f.buyer ?? "").slice(0, 100);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(f.from ?? "") ? f.from! : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(f.to ?? "") ? f.to! : "";
  const predicates: string[] = [];
  const args: string[] = [];
  if (status === "draft") predicates.push("s.status='draft' AND NOT EXISTS(SELECT 1 FROM sendout_messages x WHERE x.sendout_id=s.id AND x.status='failed')");
  if (status === "sent") predicates.push("s.status='sent'");
  if (status === "failed") predicates.push("s.status='draft' AND EXISTS(SELECT 1 FROM sendout_messages x WHERE x.sendout_id=s.id AND x.status='failed') AND NOT EXISTS(SELECT 1 FROM sendout_messages x WHERE x.sendout_id=s.id AND x.status IN ('sent','outbox','replied'))");
  if (buyer) { predicates.push("EXISTS(SELECT 1 FROM sendout_messages x JOIN buyers b ON b.id=x.buyer_id WHERE x.sendout_id=s.id AND b.name LIKE ?)"); args.push(`%${buyer}%`); }
  if (from) { predicates.push("date(s.created_at)>=date(?)"); args.push(from); }
  if (to) { predicates.push("date(s.created_at)<=date(?)"); args.push(to); }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const rows = db().prepare(`SELECT s.id, s.name, s.status, s.upload_ids, s.created_at, s.sent_at, u.initials by_user,
    (SELECT count(*) FROM sendout_messages m WHERE m.sendout_id=s.id) emails,
    (SELECT count(*) FROM sendout_messages m WHERE m.sendout_id=s.id AND m.status IN ('sent','outbox','replied')) delivered,
    (SELECT count(*) FROM sendout_messages m WHERE m.sendout_id=s.id AND m.status='replied') replied,
    (SELECT count(*) FROM sendout_messages m WHERE m.sendout_id=s.id AND m.status='failed') failed
    FROM sendouts s LEFT JOIN users u ON u.id = s.created_by ${where} ORDER BY s.id DESC`).all(...args) as { id: number; name: string; status: string; upload_ids: string; created_at: string; sent_at: string | null; by_user: string | null; emails: number; delivered: number; replied: number; failed: number }[];
  const buyers = db().prepare("SELECT DISTINCT b.name FROM buyers b JOIN sendout_messages m ON m.buyer_id=b.id ORDER BY b.name").all() as { name: string }[];
  return (
    <>
      <PageHead title="Sendout Tracking" sub="Every sendout, its emails and the replies logged against them."><Link href="/console/sendouts/new" className="btn btn-ink !h-10">New sendout</Link></PageHead>
      <Panel className="mb-4 p-3"><form className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-stone">Status<select name="status" defaultValue={status} className="field mt-1 !min-h-[38px]"><option value="">All statuses</option><option value="draft">Draft</option><option value="sent">Sent / outbox</option><option value="failed">All failed</option></select></label>
        <label className="text-xs text-stone">Buyer<select name="buyer" defaultValue={buyer} className="field mt-1 !min-h-[38px]"><option value="">All buyers</option>{buyers.map((b) => <option key={b.name}>{b.name}</option>)}</select></label>
        <label className="text-xs text-stone">Created from<input type="date" name="from" defaultValue={from} className="field mt-1 !min-h-[38px]" /></label>
        <label className="text-xs text-stone">Created to<input type="date" name="to" defaultValue={to} className="field mt-1 !min-h-[38px]" /></label>
        <button className="btn btn-ink !h-[38px]">Filter</button><Link href="/console/sendouts" className="px-2 py-2 text-sm text-stone">Reset</Link>
      </form></Panel>
      <Panel className="overflow-x-auto">
        <table className="w-full">
          <thead><tr><Th>Sendout</Th><Th>Status</Th><Th className="text-right">Listings</Th><Th className="text-right">Emails</Th><Th className="text-right">Delivered</Th><Th className="text-right">Replies</Th><Th className="text-right">Failed</Th><Th>By</Th><Th>Created</Th><Th>Sent</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="hover:bg-bone/60">
              <Td><Link className="font-medium hover:underline" href={r.status === "sent" ? `/console/sendouts/${r.id}/send` : `/console/sendouts/${r.id}/compose`}>{r.name}</Link></Td>
              <Td><Pill tone={statusTone(r.failed && !r.delivered ? "failed" : r.status)}>{r.failed && !r.delivered ? "failed" : r.status}</Pill></Td><Td className="text-right tabular-nums">{json<number[]>(r.upload_ids, []).length}</Td>
              <Td className="text-right tabular-nums">{r.emails}</Td><Td className="text-right tabular-nums">{r.delivered}</Td><Td className="text-right tabular-nums">{r.replied}</Td><Td className="text-right tabular-nums">{r.failed || "—"}</Td>
              <Td>{r.by_user}</Td><Td className="text-stone">{fmtDateTime(r.created_at)}</Td><Td className="text-stone">{fmtDateTime(r.sent_at)}</Td>
            </tr>))}</tbody>
        </table>
        {!rows.length && <p className="p-10 text-center text-stone">No sendouts yet. <Link className="underline" href="/console/sendouts/new">Start one</Link>.</p>}
      </Panel>
    </>
  );
}
