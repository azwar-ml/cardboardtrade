"use client";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Loader2, Paperclip } from "lucide-react";

type V = { id: number; name: string; city: string; status: string; online: number; last: string | null };

function Submit({ ready }: { ready: boolean }) {
  const { pending } = useFormStatus();
  return <button disabled={!ready || pending} className="btn btn-ink disabled:opacity-40">{pending ? <><Loader2 className="size-4 animate-spin" />Checking…</> : "Upload"}</button>;
}

function Drop({ name, multiple, accept, label, hint, onChange, files }: { name: string; multiple?: boolean; accept: string; label: string; hint: string; onChange: (f: File[]) => void; files: File[] }) {
  return (
    <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-line bg-white px-4 py-8 text-center transition-colors hover:border-ink/40">
      <Paperclip className="size-4 text-stone" strokeWidth={1.5} />
      <span className="text-sm">{files.length ? files.map((f) => f.name).join(", ") : label}</span>
      <span className="text-[12px] text-stone">{hint}</span>
      <input type="file" name={name} multiple={multiple} accept={accept} className="sr-only" onChange={(e) => onChange(Array.from(e.target.files ?? []))} />
    </label>
  );
}

export default function UploadForm({ action, vendors, preselect }: { action: (fd: FormData) => void; vendors: V[]; preselect?: string }) {
  const [vendor, setVendor] = useState(preselect ?? "");
  const [raw, setRaw] = useState<File[]>([]);
  const [t, setT] = useState<File[]>([]);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState("");
  const v = vendors.find((x) => String(x.id) === vendor);
  const ready = !!vendor && t.length > 0 && (raw.length > 0 || text.trim().length > 0);
  return (
    <form action={action} className="space-y-5">
      <div>
        <label className="field-label" htmlFor="vendor">Vendor</label>
        <select id="vendor" name="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} className="field" required>
          <option value="">Choose a vendor</option>
          {vendors.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.city}</option>)}
        </select>
        {v && <p className="mt-2 text-sm text-stone">{v.online} lots online now · status {v.status}{v.last ? ` · last upload ${v.last.slice(0, 10)}` : " · first upload"}</p>}
      </div>
      <div>
        <div className="flex items-center justify-between"><span className="field-label">Raw file, as the vendor sent it <span className="font-normal text-stone">Required</span></span><button type="button" onClick={() => setPaste((p) => !p)} className="text-sm underline">{paste ? "Attach files instead" : "Paste email / WhatsApp text"}</button></div>
        {paste ? <textarea name="pasted" value={text} onChange={(e) => setText(e.target.value)} rows={6} className="field font-mono text-[13px]" placeholder="Paste the vendor's message exactly as received…" />
          : <Drop name="raw" multiple accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.txt" label="Drop the vendor's file here, or click to add" hint="Excel, CSV, PDF or image. Several files are fine." files={raw} onChange={setRaw} />}
      </div>
      <div>
        <span className="field-label">Transformed file <span className="font-normal text-stone">Required</span></span>
        <Drop name="transformed" accept=".xlsx,.csv" label="Drop the file in our template here" hint="BULK_UPLOAD sheet from the Cardboard Package template (.xlsx or .csv)." files={t} onChange={setT} />
      </div>
      <div><label className="field-label" htmlFor="note">Note (optional)</label><input id="note" name="note" className="field" placeholder="e.g. Weekly list, prices valid to month end" /></div>
      <div className="flex items-center gap-3">
        <Submit ready={ready} />
        <Link href="/console/uploads" className="btn btn-line text-ink">Cancel</Link>
        {!ready && <span className="text-sm text-stone">{!vendor ? "Choose a vendor first." : !(raw.length || text.trim()) ? "Add the raw file." : "Add the transformed file."}</span>}
      </div>
    </form>
  );
}
