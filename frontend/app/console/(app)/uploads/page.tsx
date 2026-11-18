import Link from "next/link";
import { db } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { PageHead, Panel, Pill, Td, Th, fmtDateTime, statusTone } from "@/components/console/ui";

export const metadata = { title: "List Upload" };

export default async function Uploads() {
  await requireUser();
  const rows = db().prepare(`SELECT u.id, u.status, u.rows_total, u.rows_ok, u.rows_error, u.created_at, u.note, v.id vendor_id, v.name vendor, usr.initials by_user,
    (SELECT count(*) FROM items i WHERE i.upload_id = u.id AND i.status = 'online') online
    FROM uploads u JOIN vendors v ON v.id = u.vendor_id LEFT JOIN users usr ON usr.id = u.created_by ORDER BY u.id DESC`).all() as { id: number; status: string; rows_total: number; rows_ok: number; rows_error: number; created_at: string; note: string | null; vendor_id: number; vendor: string; by_user: string | null; online: number }[];
  return (
    <>
      <PageHead title="List Upload" sub="Every vendor list arrives here: the raw file as sent, plus the file transformed into our template. The contract check runs by itself.">
        <a href="/api/console/template" className="btn btn-line !h-10 text-ink">Download template</a>
        <Link href="/console/uploads/new" className="btn btn-ink !h-10">New upload</Link>
      </PageHead>
      <Panel className="overflow-x-auto">
        <table className="w-full">
          <thead><tr><Th>#</Th><Th>Vendor</Th><Th>Status</Th><Th className="text-right">Rows OK</Th><Th className="text-right">Errors</Th><Th className="text-right">Online lots</Th><Th>By</Th><Th>Uploaded</Th><Th>Note</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-bone/60">
                <Td><Link href={`/console/uploads/${r.id}`} className="font-mono text-[12px] hover:underline">U-{String(r.id).padStart(4, "0")}</Link></Td>
                <Td><Link href={`/console/vendors/${r.vendor_id}`} className="hover:underline">{r.vendor}</Link></Td>
                <Td><Pill tone={statusTone(r.status)}>{r.status}</Pill></Td>
                <Td className="text-right tabular-nums">{r.rows_ok}/{r.rows_total}</Td>
                <Td className="text-right tabular-nums">{r.rows_error || "—"}</Td>
                <Td className="text-right tabular-nums">{r.online}</Td>
                <Td>{r.by_user ?? "—"}</Td>
                <Td className="text-stone">{fmtDateTime(r.created_at)}</Td>
                <Td className="max-w-[22rem] truncate text-[12px] text-stone" title={r.note ?? ""}>{r.note ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
