import Link from "next/link";

const STEPS = ["Listings", "Matched Buyers", "Compose & Review", "Send"];
const paths = (id?: number) => ["/console/sendouts/new", `/console/sendouts/${id}/buyers`, `/console/sendouts/${id}/compose`, `/console/sendouts/${id}/send`];

export default function Steps({ active, id, locked = false }: { active: number; id?: number; locked?: boolean }) {
  return (
    <nav aria-label="Sendout steps" className="mb-6 flex flex-wrap gap-1 border-b border-line">
      {STEPS.map((s, i) => {
        const reachable = !locked && (i === 0 || (id && i <= Math.max(active, 2)));
        const cls = `relative -mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-[15px] ${i === active ? "border-accent text-ink" : "border-transparent text-stone"}`;
        const inner = <><span className={`grid size-5 place-items-center rounded-full font-mono text-[11px] ${i === active ? "bg-ink text-white" : "ring-1 ring-line"}`}>{i + 1}</span>{s}</>;
        return reachable && i !== active ? <Link key={s} href={paths(id)[i]} className={cls + " hover:text-ink"}>{inner}</Link> : <span key={s} className={cls}>{inner}</span>;
      })}
    </nav>
  );
}
