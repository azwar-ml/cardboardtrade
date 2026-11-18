import Reveal from "./Reveal";
import SectionHead from "./SectionHead";
import { smart } from "@/lib/content";

const extract = [
  ["Box type", "RSC"],
  ["Ply / flute", "5 · BC"],
  ["Outer liner", "150 GSM kraft"],
  ["Burst", "14 kg/cm²"],
  ["Print", "2-colour flexo"],
  ["Internal size", "1380 × 160 × 860 mm"],
];

export default function SmartMatching() {
  return (
    <section className="py-24 lg:py-32">
      <div className="wrap">
        <SectionHead n="05" label={smart.eyebrow} title={smart.title} body={smart.body} />
        <div className="mt-16 grid gap-12 md:grid-cols-12">
          <Reveal className="md:col-span-5 md:col-start-4">
            <div className="rounded-[8px] border border-line bg-paper p-6">
              <p className="label-mono text-stone">Extracted from “TV boxes Dubai.pdf”</p>
              <dl className="mt-4 divide-y divide-line font-mono text-[13px]">
                {extract.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 py-2.5">
                    <dt className="text-stone">{k}</dt>
                    <dd className="text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
          <ol className="md:col-span-4">
            {smart.points.map((p, i) => (
              <Reveal key={p.title} delay={0.06 * i}>
                <li className="border-t border-line py-6 first:border-t-0 first:pt-0">
                  <h3 className="text-xl text-ink">{p.title}</h3>
                  <p className="mt-2 leading-relaxed text-stone">{p.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
