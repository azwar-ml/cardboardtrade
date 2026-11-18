"use client";
import { useState } from "react";
import { useFormStatus } from "react-dom";

type Sig = { label: string; points: number; tone: "good" | "info" | "warn" };
export type Row = { buyerId: number; company: string; country: string; score: number; choice: string; signals: Sig[]; port: string | null; transit: number | null; lots: number; pcs: number; lines: string[]; am: string | null; contact: { name: string; email: string; bounce: string } | null; excluded: string | null; lastSent: string | null; included: boolean };

const tone = { good: "bg-[#e6f2ea] text-[#1f6b3a]", info: "bg-bone text-ink ring-1 ring-line", warn: "bg-[#fdf1e7] text-[#9a4a12]" };

function Go({ n }: { n: number }) {
  const { pending } = useFormStatus();
  return <button disabled={!n || pending} className="btn btn-ink disabled:opacity-40">{pending ? "Writing emails…" : "Compose emails"}</button>;
}

export default function BuyerPicker({ rows, action, sendoutId }: { rows: Row[]; action: (fd: FormData) => void; sendoutId: number }) {
  const [inc, setInc] = useState<Set<number>>(new Set(rows.filter((r) => r.included).map((r) => r.buyerId)));
  const [am, setAm] = useState("");
  const [choice, setChoice] = useState("");
  const [q, setQ] = useState("");
  const live = rows.filter((r) => !r.excluded);
  const view = rows.filter((r) => (!am || r.am === am) && (!choice || r.choice === choice) && (!q || r.company.toLowerCase().includes(q.toLowerCase())));
  const toggle = (id: number) => setInc((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = live.length > 0 && live.every((r) => inc.has(r.buyerId));
  const ams = [...new Set(rows.map((r) => r.am).filter(Boolean))] as string[];
  const cls = "field !min-h-[38px] !w-auto !py-1.5 text-sm";
  return (
    <form action={action}>
      <input type="hidden" name="id" value={sendoutId} />
      {[...inc].map((id) => <input key={id} type="hidden" name="include" value={id} />)}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buyer, company" className="field !min-h-[38px] !w-52 !py-1.5 text-sm" />
        <select value={am} onChange={(e) => setAm(e.target.value)} className={cls}><option value="">All AMs</option>{ams.map((a) => <option key={a}>{a}</option>)}</select>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} className={cls}><option value="">Any choice buyer</option><option value="1st">1st only</option><option value="2nd">2nd only</option><option value="mixed">Any choice</option></select>
        <span className="ml-auto text-sm text-stone">{inc.size} of {live.length} buyers included · {rows.length - live.length} held back</span>
      </div>
      <div className="overflow-x-auto rounded-[8px] border border-line bg-paper">
        <table className="w-full">
          <thead><tr className="text-left text-[12px] text-stone">
            <th className="border-b border-line px-3 py-2.5"><input type="checkbox" checked={all} onChange={() => setInc(all ? new Set() : new Set(live.map((r) => r.buyerId)))} className="size-4 accent-accent" aria-label="Include all" /></th>
            {["Score", "Company", "Last sent", "Choice", "Signals", "Port · transit", "Lots", "Pieces", "AM", "Send to"].map((h) => <th key={h} className="whitespace-nowrap border-b border-line px-3 py-2.5 font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {view.map((r) => r.excluded ? (
              <tr key={r.buyerId} className="text-[13.5px] text-stone">
                <td className="border-b border-line/70 px-3 py-2.5" />
                <td className="border-b border-line/70 px-3 tabular-nums">{r.score}</td>
                <td className="border-b border-line/70 px-3">{r.company}</td>
                <td colSpan={8} className="border-b border-line/70 px-3 italic">{r.excluded}</td>
              </tr>
            ) : (
              <tr key={r.buyerId} onClick={() => toggle(r.buyerId)} className={`cursor-pointer text-[13.5px] ${inc.has(r.buyerId) ? "" : "opacity-50"} hover:bg-bone/60`}>
                <td className="border-b border-line/70 px-3 py-2.5"><input type="checkbox" checked={inc.has(r.buyerId)} onChange={() => toggle(r.buyerId)} onClick={(e) => e.stopPropagation()} className="size-4 accent-accent" aria-label={`Include ${r.company}, buyer ${r.buyerId}`} /></td>
                <td className="border-b border-line/70 px-3 font-medium tabular-nums">{r.score}</td>
                <td className="border-b border-line/70 px-3"><span className="font-medium">{r.company}</span><span className="block text-[12px] text-stone">{r.lines.join(", ")}</span></td>
                <td className="whitespace-nowrap border-b border-line/70 px-3 text-stone">{r.lastSent ? r.lastSent.slice(0, 10) : "—"}</td>
                <td className="border-b border-line/70 px-3">{r.choice === "mixed" ? "Mixed" : r.choice}</td>
                <td className="border-b border-line/70 px-3"><div className="flex max-w-[22rem] flex-wrap gap-1">{r.signals.filter((s) => !/·/.test(s.label)).map((s) => <span key={s.label} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] ${tone[s.tone]}`}>{s.label}</span>)}</div></td>
                <td className="whitespace-nowrap border-b border-line/70 px-3">{r.port ? `${r.port.split(",")[0]} · ${r.transit}d` : "No lane"}</td>
                <td className="border-b border-line/70 px-3 text-right tabular-nums">{r.lots}</td>
                <td className="border-b border-line/70 px-3 text-right tabular-nums">{r.pcs.toLocaleString("en-US")}</td>
                <td className="border-b border-line/70 px-3">{r.am ?? "—"}</td>
                <td className="border-b border-line/70 px-3"><span className="underline decoration-line underline-offset-4">{r.contact?.name}</span>{r.contact?.bounce === "soft" && <span className="ml-2 rounded-full bg-[#fdf1e7] px-2 py-0.5 text-[12px] text-[#9a4a12]">Soft bounce</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sticky bottom-0 mt-4 flex items-center justify-end gap-4 border-t border-line bg-bone/95 py-4 backdrop-blur">
        <span className="text-sm text-stone">{inc.size} buyers included</span>
        <Go n={inc.size} />
      </div>
    </form>
  );
}
