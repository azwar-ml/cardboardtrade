import Reveal from "./Reveal";

/** Editorial section header: numbered mono label on the left, headline and intro on the right. */
export default function SectionHead({ n, label, title, body, dark = false }: { n: string; label: string; title: React.ReactNode; body?: React.ReactNode; dark?: boolean }) {
  return (
    <div className={`grid gap-6 pt-6 md:grid-cols-12 ${dark ? "rule-dark" : "rule"}`}>
      <Reveal className="md:col-span-3">
        <p className={`label-mono ${dark ? "text-fog" : "text-stone"}`}>
          <span className="text-accent">{n}</span>&nbsp;&nbsp;{label}
        </p>
      </Reveal>
      <div className="md:col-span-9">
        <Reveal delay={0.05}>
          <h2 className={`max-w-[20ch] text-[2.4rem] leading-[1.02] md:text-[3.6rem] ${dark ? "text-bone" : "text-ink"}`}>{title}</h2>
        </Reveal>
        {body && (
          <Reveal delay={0.1}>
            <p className={`mt-6 max-w-2xl text-lg leading-relaxed ${dark ? "text-fog" : "text-stone"}`}>{body}</p>
          </Reveal>
        )}
      </div>
    </div>
  );
}
