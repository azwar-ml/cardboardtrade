import { Minus, ArrowRight } from "lucide-react";
import Reveal from "./Reveal";
import SectionHead from "./SectionHead";
import { comparison } from "@/lib/content";

export default function Comparison() {
  const rows = comparison.without.items.map((w, i) => [w, comparison.with.items[i]]);
  return (
    <section className="bg-ink py-24 text-bone lg:py-32">
      <div className="wrap">
        <SectionHead n="02" label="The difference" title={comparison.title} dark />
        <Reveal delay={0.1}>
          <div className="mt-16 md:ml-[25%]">
            <div className="grid grid-cols-2 gap-8 border-b border-white/12 pb-4">
              <p className="label-mono text-fog">{comparison.without.label}</p>
              <p className="label-mono text-accent">{comparison.with.label}</p>
            </div>
            {rows.map(([w, c]) => (
              <div key={w} className="grid grid-cols-2 gap-8 border-b border-white/12 py-6">
                <p className="flex gap-3 leading-relaxed text-fog"><Minus className="mt-1 size-4 shrink-0" strokeWidth={1.5} />{w}</p>
                <p className="flex gap-3 leading-relaxed text-bone"><ArrowRight className="mt-1 size-4 shrink-0 text-accent" strokeWidth={1.5} />{c}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
