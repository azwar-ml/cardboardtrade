import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, json } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { publishUpload, runCheck, type StoredFile } from "@/lib/trade/uploads";
import type { Issue, Row } from "@/lib/trade/template";
import { PageHead, Panel, Pill, Td, Th, fmtDateTime, fmtInt, statusTone } from "@/components/console/ui";

export const metadata = { title: "Upload" };

async function publish(fd: FormData) {
  "use server";
  await requireUser("admin");
  const id = Number(fd.get("id"));
  publishUpload(id, { replacePrevious: fd.get("replace") === "on" });
  revalidatePath(`/console/uploads/${id}`);
  redirect(`/console/inventory?vendor=${fd.get("vendor")}`);
}
async function recheck(fd: FormData) {
  "use server";
  await requireUser();
  const id = Number(fd.get("id"));
  await runCheck(id);
  revalidatePath(`/console/uploads/${id}`);
}

export default async function UploadDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  const u = db().prepare("SELECT u.*, v.name vendor, v.id vid, v.status vendor_status, usr.name by_name FROM uploads u JOIN vendors v ON v.id = u.vendor_id LEFT JOIN users usr ON usr.id = u.created_by WHERE u.id = ?").get(id) as
    { id: number; status: string; raw_files: string; transformed_file: string; transformed_sha: string; rows_total: number; rows_ok: number; rows_error: number; issues: string; parsed: string; note: string | null; created_at: string; checked_at: string | null; published_at: string | null; vendor: string; vid: number; vendor_status: string; by_name: string | null } | undefined;
  if (!u) notFound();
  const raw = json<StoredFile[]>(u.raw_files, []);
  const issues = json<Issue[]>(u.issues, []);
  const rows = json<(Row & { _ok: boolean })[]>(u.parsed, []);
  const errors = issues.filter((i) => i.level === "error"), warnings = issues.filter((i) => i.level === "warning");
  const online = (db().prepare("SELECT count(*) n FROM items WHERE upload_id = ? AND status='online'").get(id) as { n: number }).n;
  const steps = [["Uploaded", true], ["Checked", ["checked", "published", "superseded"].includes(u.status)], ["Published", ["published", "superseded"].includes(u.status)]] as const;
  return (
    <>
      <p className="mb-2 text-sm text-stone"><Link href="/console/uploads" className="underline">List Upload</Link> / U-{String(id).padStart(4, "0")}</p>
      <PageHead title={u.vendor} sub={<>Uploaded {fmtDateTime(u.created_at)}{u.by_name ? ` by ${u.by_name}` : ""}{u.note ? ` · ${u.note}` : ""}</>}>
        <Pill tone={statusTone(u.status)}>{u.status}</Pill>
      </PageHead>

      <ol className="mb-6 flex gap-2">
        {steps.map(([label, done], i) => <li key={label} className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm ring-1 ${done ? "bg-ink text-white ring-ink" : "text-stone ring-line"}`}><span className="font-mono text-[11px]">{i + 1}</span>{label}</li>)}
        {u.status === "failed" && <li className="rounded-full bg-[#fbe6e1] px-3 py-1 text-sm text-[#a12d16]">Check failed</li>}
      </ol>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="p-5">
          <p className="label-mono text-stone">Raw file(s) as sent</p>
          <ul className="mt-3 space-y-2 text-sm">{raw.map((f) => <li key={f.path}><a className="underline" href={`/api/console/files/${f.path}`}>{f.name.replace(/^[0-9a-f]{12}-/, "")}</a><span className="block font-mono text-[11px] text-stone">sha256 {f.sha256.slice(0, 20)}… · {fmtInt(f.size / 1024)} KB</span></li>)}</ul>
        </Panel>
        <Panel className="p-5">
          <p className="label-mono text-stone">Transformed file</p>
          <p className="mt-3 text-sm"><a className="underline" href={`/api/console/files/${u.transformed_file}`}>{u.transformed_file.split("/").pop()!.replace(/^[0-9a-f]{12}-/, "")}</a></p>
          <p className="font-mono text-[11px] text-stone">sha256 {u.transformed_sha.slice(0, 20)}…</p>
          <form action={recheck} className="mt-3"><input type="hidden" name="id" value={id} /><button className="text-sm underline">Run the check again</button></form>
        </Panel>
        <Panel className="p-5">
          <p className="label-mono text-stone">Contract check</p>
          <p className="mt-3 font-display text-3xl tabular-nums">{u.rows_ok}<span className="text-lg text-stone"> / {u.rows_total} rows pass</span></p>
          <p className="text-sm text-stone">{errors.length} errors · {warnings.length} warnings · {online} lots online from this upload</p>
          {u.status === "checked" && u.vendor_status !== "blocked" && user.role === "admin" && (
            <form action={publish} className="mt-4 space-y-3">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="vendor" value={u.vid} />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="replace" defaultChecked className="accent-accent" />Take this vendor&apos;s previous online lots offline</label>
              <button className="btn btn-accent w-full">Publish {u.rows_ok} rows to inventory</button>
            </form>
          )}
          {u.status === "checked" && u.vendor_status !== "blocked" && user.role !== "admin" && <p role="status" className="mt-4 text-sm text-stone">Admin approval is required to publish inventory.</p>}
          {u.status === "checked" && u.vendor_status === "blocked" && <p role="status" className="mt-4 rounded-md border border-[#f1bfb3] bg-[#fbe6e1] px-3 py-2 text-sm text-[#a12d16]">Publishing is disabled because this supplier is blocked.</p>}
        </Panel>
      </div>

      {issues.length > 0 && (
        <Panel className="mt-6 overflow-x-auto">
          <p className="label-mono border-b border-line px-4 py-3 text-stone">Issues</p>
          <table className="w-full"><thead><tr><Th>Row</Th><Th>Column</Th><Th>Level</Th><Th>Message</Th></tr></thead>
            <tbody>{issues.map((x, i) => <tr key={i}><Td className="tabular-nums">{x.row || "File"}</Td><Td>{x.column}</Td><Td><Pill tone={x.level === "error" ? "bad" : "warn"}>{x.level}</Pill></Td><Td className="whitespace-normal">{x.message}</Td></tr>)}</tbody></table>
        </Panel>
      )}

      {rows.length > 0 && (
        <Panel className="mt-6 overflow-x-auto">
          <p className="label-mono border-b border-line px-4 py-3 text-stone">Rows read from the transformed file</p>
          <table className="w-full"><thead><tr><Th></Th><Th>SKU</Th><Th>Product</Th><Th>Description</Th><Th>Choice</Th><Th>Ply</Th><Th>Size mm</Th><Th className="text-right">Qty</Th><Th className="text-right">Price</Th><Th>Location</Th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} className={r._ok ? "" : "bg-[#fbe6e1]/50"}>
                <Td>{r._ok ? <Pill tone="good">ok</Pill> : <Pill tone="bad">skip</Pill>}</Td><Td className="font-mono text-[12px]">{String(r.vendor_sku ?? "")}</Td><Td>{String(r.line ?? "")}</Td>
                <Td className="max-w-[18rem] truncate">{String(r.description ?? "")}</Td><Td>{String(r.choice ?? "")}</Td><Td>{String(r.ply ?? "")}</Td>
                <Td className="tabular-nums">{String(r.length_mm ?? "")}×{String(r.width_mm ?? "")}×{String(r.height_mm ?? "")}</Td>
                <Td className="text-right tabular-nums">{fmtInt(Number(r.qty))}</Td><Td className="text-right tabular-nums">{String(r.price ?? "")} {String(r.currency ?? "")}</Td><Td>{String(r.location ?? "")}</Td>
              </tr>))}</tbody></table>
        </Panel>
      )}
    </>
  );
}
