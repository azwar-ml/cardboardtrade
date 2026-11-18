"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import SectionHead from "./SectionHead";
import { sides, type Side } from "@/lib/content";

const order: Side[] = ["buyer", "seller"];

export default function BuyerSeller() {
  const [side, setSide] = useState<Side>("buyer");
  const s = sides[side];
  const subject = side === "buyer" ? "Buying request" : "Selling request";

  return (
    <section id="how-it-works" className="py-24 lg:py-32">
      <div className="wrap">
        <SectionHead n="03" label="How it works" title="Two sides. One partner." />

        <div role="tablist" aria-label="Choose your side" className="mt-14 flex gap-8 border-b border-line md:ml-[25%]">
          {order.map((k) => (
            <button key={k} role="tab" type="button" id={`tab-${k}`} aria-selected={side === k} aria-controls="side-panel" onClick={() => setSide(k)}
              className={`relative -mb-px pb-4 text-lg transition-colors ${side === k ? "text-ink" : "text-stone hover:text-ink"}`}>
              {sides[k].tab}
              {side === k && <motion.span layoutId="side-underline" className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" />}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={side} id="side-panel" role="tabpanel" aria-labelledby={`tab-${side}`}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="mt-12 grid gap-10 md:grid-cols-12">
            <div className="relative min-h-[420px] overflow-hidden rounded-[8px] bg-ink md:col-span-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={side === "buyer" ? "/img/racks.jpg" : "/img/hall.jpg"} alt="" className="absolute inset-0 size-full object-cover opacity-60 grayscale-[.4]" />
              <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/40 to-transparent" />
              <div className="relative flex h-full flex-col justify-end p-8 text-white">
                <h3 className="max-w-sm text-3xl leading-tight">{s.title}</h3>
                <p className="mt-3 max-w-sm leading-relaxed text-white/70">{s.body}</p>
                <a href="#contact" data-subject={subject} className="btn btn-accent mt-6 self-start">{s.cta} <ArrowRight className="arrow size-4" strokeWidth={1.75} /></a>
              </div>
            </div>

            <div className="md:col-span-7">
              <dl className="grid sm:grid-cols-2">
                {s.benefits.map((b) => (
                  <div key={b.title} className="border-t border-line py-6 sm:pr-8">
                    <dt className="text-lg text-ink">{b.title}</dt>
                    <dd className="mt-1.5 leading-relaxed text-stone">{b.body}</dd>
                  </div>
                ))}
              </dl>
              <p className="label-mono mt-10 text-stone">The process</p>
              <ol className="mt-4 grid gap-px overflow-hidden rounded-[8px] border border-line bg-line sm:grid-cols-3">
                {s.steps.map((st, i) => (
                  <li key={st.title} className="bg-paper p-6">
                    <span className="font-mono text-sm text-accent">Step {i + 1}</span>
                    <h4 className="mt-3 text-lg leading-snug text-ink">{st.title}</h4>
                    <p className="mt-2 text-[15px] leading-relaxed text-stone">{st.body}</p>
                  </li>
                ))}
              </ol>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
