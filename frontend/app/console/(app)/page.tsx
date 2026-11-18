import Link from "next/link";
import { Bot } from "lucide-react";
import { db } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { PageHead, Panel, Pill, Stat, Td, Th, fmtDateTime, fmtInt, statusTone } from "@/components/console/ui";

export const metadata = { title: "Overview" };

export default async function Overview({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requireUser();
  const { denied } = await searchParams;
  const d = db();
  const n = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
  const inv = d.prepare("SELECT count(*) lots, coalesce(sum(qty),0) pcs, coalesce(sum(qty*cbm_per_1000/1000),0) cbm FROM items WHERE status='online'").get() as { lots: number; pcs: number; cbm: number };
  const byLine = d.prepare("SELECT line, count(*) lots, sum(qty) pcs, count(DISTINCT vendor_id) vendors FROM items WHERE status='online' GROUP BY line ORDER BY family, line").all() as { line: string; lots: number; pcs: number; vendors: number }[];
  const uploads = d.prepare("SELECT u.id, u.status, u.rows_ok, u.rows_total, u.created_at, v.name FROM uploads u JOIN vendors v ON v.id=u.vendor_id ORDER BY u.id DESC LIMIT 8").all() as { id: number; status: string; rows_ok: number; rows_total: number; created_at: string; name: string }[];
  const demo = n("SELECT count(*) n FROM items WHERE status='online' AND price_source='demo-model'");
  return (
    <>
      <PageHead title={`Good day, ${user.name.split(" ")[0]}`} sub="Virtual inventory from Pakistani vendors, matched to buyers abroad.">
        {user.role === "admin" && <Link href="/console/admin/agents" className="btn btn-accent !h-10 !px-4 text-sm"><Bot className="size-4" />Open AI Control Center</Link>}
      </PageHead>
      {denied && <p className="mb-4 rounded-[6px] bg-[#fdf1e7] px-4 py-3 text-sm text-[#9a4a12]">That page is for admins only.</p>}
      {demo > 0 && (
        <p className="mb-6 rounded-[6px] border border-line bg-paper px-4 py-3 text-sm text-stone">
          <strong className="text-ink"></strong> Vendors are real companies from our research. Their {fmtInt(demo)} stock lots are <em>generated</em> from each vendor&apos;s published product range with model prices. Replace a vendor&apos;s lots by uploading their real list in <Link href="/console/uploads/new" className="underline">List Upload</Link>.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Online lots" value={fmtInt(inv.lots)} href="/console/inventory" />
        <Stat label="Pieces online" value={fmtInt(inv.pcs)} />
        <Stat label="Shipping CBM" value={fmtInt(inv.cbm)} />
        <Stat label="Vendors" value={n("SELECT count(*) n FROM vendors")} href="/console/vendors" />
        <Stat label="Buyers" value={n("SELECT count(*) n FROM buyers")} href="/console/buyers" />
        <Stat label="Sendouts sent" value={n("SELECT count(*) n FROM sendouts WHERE status='sent'")} href="/console/sendouts" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel>
          <p className="label-mono border-b border-line px-4 py-3 text-stone">Stock by product line</p>
          <table className="w-full"><thead><tr><Th>Product</Th><Th className="text-right">Lots</Th><Th className="text-right">Pieces</Th><Th className="text-right">Vendors</Th></tr></thead>
            <tbody>{byLine.map((r) => (<tr key={r.line}><Td><Link className="hover:underline" href={`/console/inventory?line=${encodeURIComponent(r.line)}`}>{r.line}</Link></Td><Td className="text-right tabular-nums">{r.lots}</Td><Td className="text-right tabular-nums">{fmtInt(r.pcs)}</Td><Td className="text-right tabular-nums">{r.vendors}</Td></tr>))}</tbody></table>
        </Panel>
        <Panel>
          <div className="flex items-center justify-between border-b border-line px-4 py-3"><p className="label-mono text-stone">Latest uploads</p><Link href="/console/uploads/new" className="btn btn-ink !h-8 !px-3 text-sm">New upload</Link></div>
          <table className="w-full"><thead><tr><Th>Vendor</Th><Th>Status</Th><Th className="text-right">Rows</Th><Th>When</Th></tr></thead>
            <tbody>{uploads.map((u) => (<tr key={u.id}><Td><Link className="hover:underline" href={`/console/uploads/${u.id}`}>{u.name}</Link></Td><Td><Pill tone={statusTone(u.status)}>{u.status}</Pill></Td><Td className="text-right tabular-nums">{u.rows_ok}/{u.rows_total}</Td><Td className="text-stone">{fmtDateTime(u.created_at)}</Td></tr>))}</tbody></table>
        </Panel>
      </div>
    </>
  );
}
