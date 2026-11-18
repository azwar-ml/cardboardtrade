import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/trade/db";
import { requireUser } from "@/lib/trade/auth";
import { createUpload, storeFile } from "@/lib/trade/uploads";
import { PageHead, Panel } from "@/components/console/ui";
import UploadForm from "@/components/console/UploadForm";

export const metadata = { title: "New upload" };

async function upload(fd: FormData) {
  "use server";
  const user = await requireUser();
  const vendorId = Number(fd.get("vendor"));
  const raws = fd.getAll("raw").filter((f): f is File => f instanceof File && f.size > 0);
  const pasted = String(fd.get("pasted") ?? "").trim();
  const t = fd.get("transformed");
  if (!vendorId || !(t instanceof File) || !t.size || (!raws.length && !pasted)) redirect("/console/uploads/new?error=missing");
  if (!/\.(xlsx|csv)$/i.test((t as File).name)) redirect("/console/uploads/new?error=type");
  const raw = await Promise.all(raws.map(async (f) => storeFile(Buffer.from(await f.arrayBuffer()), f.name, f.type)));
  if (pasted) raw.push(storeFile(Buffer.from(pasted, "utf8"), `email_text_${new Date().toISOString().slice(0, 10)}.txt`, "text/plain"));
  const transformed = storeFile(Buffer.from(await (t as File).arrayBuffer()), (t as File).name, (t as File).type);
  const id = await createUpload({ vendorId, raw, transformed, userId: user.id, note: String(fd.get("note") ?? "") || undefined });
  redirect(`/console/uploads/${id}`);
}

export default async function NewUpload({ searchParams }: { searchParams: Promise<{ vendor?: string; error?: string }> }) {
  await requireUser();
  const { vendor, error } = await searchParams;
  const vendors = db().prepare(`SELECT v.id, v.name, v.city, v.status, (SELECT count(*) FROM items i WHERE i.vendor_id = v.id AND i.status='online') online,
    (SELECT max(created_at) FROM uploads u WHERE u.vendor_id = v.id) last FROM vendors v WHERE v.status != 'blocked' ORDER BY v.name`).all() as { id: number; name: string; city: string; status: string; online: number; last: string | null }[];
  return (
    <>
      <p className="mb-2 text-sm text-stone"><Link href="/console/uploads" className="underline">List Upload</Link> / New upload</p>
      <PageHead title="New Upload" />
      {error && <p role="alert" className="mb-4 rounded-[6px] bg-[#fbe6e1] px-4 py-3 text-sm text-[#a12d16]">{error === "type" ? "The transformed file must be our template as .xlsx or .csv." : "Choose a vendor, add the raw file (or paste the email text) and the transformed file."}</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,46rem)_1fr]">
        <UploadForm action={upload} vendors={vendors} preselect={vendor} />
        <div className="space-y-4">
          <Panel className="p-5"><h2 className="text-lg">Raw file, as the vendor sent it</h2><p className="mt-1 text-sm leading-relaxed text-stone">Excel, CSV, PDF, photos or WhatsApp / email text. It is kept untouched with its SHA-256 hash, so we can always show what the vendor actually offered.</p></Panel>
          <Panel className="p-5"><h2 className="text-lg">Transformed file</h2><p className="mt-1 text-sm leading-relaxed text-stone">The same stock in the <a href="/api/console/template" className="underline">Cardboard Package template</a> (sheet BULK_UPLOAD). Corrections are made in that file and it is uploaded again; this page never edits a cell.</p></Panel>
          <Panel className="p-5"><h2 className="text-lg">Checked by itself</h2><p className="mt-1 text-sm leading-relaxed text-stone">After upload the contract check runs straight away: required columns, allowed values, numbers, sizes in mm, 2nd-choice defect notes, duplicate SKUs. Rows that pass can then be published to inventory.</p></Panel>
        </div>
      </div>
    </>
  );
}
