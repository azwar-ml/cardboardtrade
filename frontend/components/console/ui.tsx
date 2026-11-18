import Link from "next/link";

export function PageHead({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[2rem] leading-tight">{title}</h1>
        {sub && <p className="mt-2 max-w-4xl text-sm leading-relaxed text-stone">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[8px] border border-line bg-paper ${className}`}>{children}</div>;
}

const tones: Record<string, string> = {
  good: "bg-[#e6f2ea] text-[#1f6b3a] ring-[#bfdcc8]", info: "bg-bone text-ink ring-line", warn: "bg-[#fdf1e7] text-[#9a4a12] ring-[#f3cfb2]",
  bad: "bg-[#fbe6e1] text-[#a12d16] ring-[#f1bfb3]", ink: "bg-ink text-white ring-ink", muted: "bg-transparent text-stone ring-line",
};
export function Pill({ children, tone = "info", title }: { children: React.ReactNode; tone?: keyof typeof tones | string; title?: string }) {
  return <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ${tones[tone] ?? tones.info}`}>{children}</span>;
}

export const statusTone = (s: string) => ({ online: "good", checked: "good", published: "good", active: "good", sent: "good", outbox: "good", replied: "good", reserved: "warn", uploaded: "info", prospect: "info", onboarding: "warn", draft: "info", queued: "info", offline: "muted", superseded: "muted", sold: "muted", failed: "bad", blocked: "bad" } as Record<string, string>)[s] ?? "info";

export function Stat({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) {
  const inner = (<><p className="font-display text-3xl tabular-nums tracking-[-0.03em]">{value}</p><p className="label-mono mt-1 text-stone">{label}</p></>);
  return href ? <Link href={href} className="rounded-[8px] border border-line bg-paper p-5 hover:border-ink/30">{inner}</Link> : <div className="rounded-[8px] border border-line bg-paper p-5">{inner}</div>;
}

export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`whitespace-nowrap border-b border-line px-3 py-2.5 text-left text-[12px] font-medium text-stone ${className}`}>{children}</th>;
}
export function Td({ children, className = "", title, colSpan }: { children?: React.ReactNode; className?: string; title?: string; colSpan?: number }) {
  return <td title={title} colSpan={colSpan} className={`whitespace-nowrap border-b border-line/70 px-3 py-2.5 text-[13.5px] ${className}`}>{children}</td>;
}

export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
export const fmtDate = (s: string | null | undefined) => (s ? new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const fmtDateTime = (s: string | null | undefined) => (s ? new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
