"use client";
import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

export type Listing = { id: number; date: string; vendor: string; city: string; am: string | null; lines: string[]; choices: string[]; lots: number; pcs: number; cbm: number; priceMin: number; priceMax: number; matches: number; held: number; lastSent: string | null; lastSentBy: string | null };

function Go({ n }: { n: number }) {
  const { pending } = useFormStatus();
  return <button disabled={!n || pending} className="btn btn-ink disabled:opacity-40">{pending ? "Matching…" : "View matched buyers"}</button>;
}

export default function ListingPicker({ listings, action }: { listings: Listing[]; action: (fd: FormData) => void }) {
  const [sel, setSel] = useState<number[]>([]);
  const [q, setQ] = useState("");
  const [line, setLine] = useState("");
  const [sent, setSent] = useState("");
  const allLines = useMemo(() => [...new Set(listings.flatMap((l) => l.lines))].sort(), [listings]);
  const rows = listings.filter((l) => (!q || (l.vendor + l.city).toLowerCase().includes(q.toLowerCase())) && (!line || l.lines.includes(line)) && (!sent || (sent === "no" ? !l.lastSent : !!l.lastSent)));
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const selected = listings.filter((l) => sel.includes(l.id));
  const cls = "field !min-h-[38px] !w-auto !py-1.5 text-sm";
  return (
    <form action={action}>
      {sel.map((id) => <input key={id} type="hidden" name="upload" value={id} />)}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-paper p-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor or city" className="field !min-h-[38px] !w-56 !py-1.5 text-sm" />
        <select value={line} onChange={(e) => setLine(e.target.value)} className={cls}><option value="">Any product</option>{allLines.map((l) => <option key={l}>{l}</option>)}</select>
        <select value={sent} onChange={(e) => setSent(e.target.value)} className={cls}><option value="">Sent or not</option><option value="no">Not sent yet</option><option value="yes">Already sent</option></select>
        <span className="ml-auto text-sm text-stone">{listings.length} listings · {sel.length} selected</span>
      </div>
      <div className="overflow-x-auto rounded-[8px] border border-line bg-paper">
        <p className="flex justify-between border-b border-line px-4 py-3 text-sm"><span className="font-medium">Vendor listings with online stock</span><span className="text-stone">newest first</span></p>
        <table className="w-full">
          <thead><tr className="text-left text-[12px] text-stone">{["", "Listed", "Vendor", "Products", "Choices", "Lots", "Pieces", "CBM", "Offer FOB $/pc", "Origin", "Matches", "Last sent", "AM"].map((h, i) => <th key={i} className="whitespace-nowrap border-b border-line px-3 py-2.5 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((l) => {
              const on = sel.includes(l.id);
              return (
                <tr key={l.id} onClick={() => toggle(l.id)} className={`cursor-pointer text-[13.5px] ${on ? "bg-[#fdf1ec]" : "hover:bg-bone/60"}`}>
                  <td className="border-b border-line/70 px-3 py-2.5"><input type="checkbox" checked={on} onChange={() => toggle(l.id)} onClick={(e) => e.stopPropagation()} className="size-4 accent-accent" aria-label={`Select listing ${l.vendor}, upload ${l.id}`} /></td>
                  <td className="whitespace-nowrap border-b border-line/70 px-3">{new Date(l.date.replace(" ", "T") + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                  <td className="border-b border-line/70 px-3 font-medium">{l.vendor}</td>
                  <td className="max-w-[18rem] border-b border-line/70 px-3"><span className="line-clamp-1" title={l.lines.join(", ")}>{l.lines.join(", ")}</span></td>
                  <td className="border-b border-line/70 px-3">{l.choices.join(", ")}</td>
                  <td className="border-b border-line/70 px-3 text-right tabular-nums">{l.lots}</td>
                  <td className="border-b border-line/70 px-3 text-right tabular-nums">{l.pcs.toLocaleString("en-US")}</td>
                  <td className="border-b border-line/70 px-3 text-right tabular-nums">{Math.round(l.cbm).toLocaleString("en-US")}</td>
                  <td className="whitespace-nowrap border-b border-line/70 px-3 text-right tabular-nums">{l.priceMin === l.priceMax ? `$${l.priceMin.toFixed(3)}` : `$${l.priceMin.toFixed(3)} – ${l.priceMax.toFixed(3)}`}</td>
                  <td className="border-b border-line/70 px-3">{l.city}</td>
                  <td className="border-b border-line/70 px-3"><span className="rounded-full bg-[#e6f2ea] px-2 py-0.5 text-[12px] font-medium text-[#1f6b3a]">{l.matches}</span>{l.held ? <span className="ml-1 text-[12px] text-stone">+{l.held} held</span> : null}</td>
                  <td className="whitespace-nowrap border-b border-line/70 px-3 text-stone">{l.lastSent ? `Sent ${l.lastSent.slice(5, 10)} ${l.lastSentBy ?? ""}` : "Not sent"}</td>
                  <td className="border-b border-line/70 px-3">{l.am ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sticky bottom-0 mt-4 flex items-center justify-between gap-4 border-t border-line bg-bone/95 py-4 backdrop-blur">
        <p className="text-sm text-stone">{sel.length ? <>{sel.length} listing{sel.length > 1 ? "s" : ""} selected · {selected.reduce((a, l) => a + l.lots, 0)} lots · {selected.reduce((a, l) => a + l.pcs, 0).toLocaleString("en-US")} pcs <button type="button" onClick={() => setSel([])} className="ml-2 underline">Clear selection</button></> : "Select listings to match them with buyers."}</p>
        <Go n={sel.length} />
      </div>
    </form>
  );
}
