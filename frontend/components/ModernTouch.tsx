"use client";
import { motion, useReducedMotion } from "motion/react";
import Reveal from "./Reveal";
import SectionHead from "./SectionHead";
import { modern } from "@/lib/content";

const spec = [
  ["Product", "TV box, 55″"],
  ["Construction", "5-ply · BC flute · RSC"],
  ["Board", "150 GSM brown kraft"],
  ["Print", "2-colour flexo"],
  ["Quantity", "20,000 pcs"],
  ["Delivery", "CFR Jebel Ali"],
];
const vendors = [
  { name: "Vendor A · Lahore", fit: 96, best: true },
  { name: "Vendor B · Faisalabad", fit: 91 },
  { name: "Vendor C · Karachi", fit: 87 },
];

/** Illustrative request → offer panel. Example data only. */
function RequestPanel() {
  const reduce = useReducedMotion();
  const show = (d: number) => ({
    initial: reduce ? false : { opacity: 0 },
    whileInView: { opacity: 1 },
    viewport: { once: true, margin: "-80px" },
    transition: { duration: 0.5, delay: d },
  });
  return (
    <div className="overflow-hidden rounded-[8px] border border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line px-6 py-3.5">
        <span className="label-mono text-stone">Example request · RFQ-0418</span>
        <span className="label-mono text-accent">Matched</span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3">
        {spec.map(([k, v], i) => (
          <motion.div key={k} {...show(i * 0.06)} className="border-b border-r border-line px-6 py-4">
            <dt className="label-mono text-stone">{k}</dt>
            <dd className="mt-1 text-[15px] text-ink">{v}</dd>
          </motion.div>
        ))}
      </dl>
      <div className="px-6 py-5">
        <p className="label-mono text-stone">Vendor fit</p>
        <ul className="mt-4 space-y-4">
          {vendors.map((v, i) => (
            <li key={v.name} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr_auto]">
              <span className={`text-[15px] ${v.best ? "font-medium text-ink" : "text-stone"}`}>{v.name}</span>
              <span className="font-mono text-sm tabular-nums text-ink sm:order-3">{v.fit}</span>
              <span className="col-span-2 h-[3px] bg-line sm:col-span-1 sm:order-2">
                <motion.span className={`block h-full ${v.best ? "bg-accent" : "bg-ink/35"}`} initial={reduce ? false : { width: 0 }} whileInView={{ width: `${v.fit}%` }} viewport={{ once: true }} transition={{ duration: 1, delay: 0.4 + i * 0.12, ease: [0.22, 1, 0.36, 1] }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <motion.div {...show(0.9)} className="flex items-center justify-between gap-4 bg-ink px-6 py-4 text-white">
        <span className="text-[15px]">One offer: price, lead time and freight</span>
        <span className="label-mono shrink-0 text-white/60">Within 48h</span>
      </motion.div>
    </div>
  );
}

export default function ModernTouch() {
  return (
    <section className="py-24 lg:py-32">
      <div className="wrap">
        <SectionHead n="01" label={modern.eyebrow} title={modern.title} body={modern.body} />
        <div className="mt-16 grid gap-12 md:grid-cols-12">
          <ol className="md:col-span-5">
            {modern.points.map((p, i) => (
              <Reveal key={p.title} delay={i * 0.06}>
                <li className="grid grid-cols-[3rem_1fr] border-t border-line py-6">
                  <span className="font-mono text-sm text-stone">0{i + 1}</span>
                  <div>
                    <h3 className="text-xl text-ink">{p.title}</h3>
                    <p className="mt-2 leading-relaxed text-stone">{p.body}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
          <Reveal delay={0.1} className="md:col-span-7"><RequestPanel /></Reveal>
        </div>
      </div>
    </section>
  );
}
