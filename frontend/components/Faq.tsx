"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import SectionHead from "./SectionHead";
import { faqs } from "@/lib/content";

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const [all, setAll] = useState(false);
  const list = all ? faqs : faqs.slice(0, 5);
  return (
    <section id="faq" className="bg-paper py-24 lg:py-32">
      <div className="wrap">
        <SectionHead n="07" label="FAQ" title="Your questions, answered" />
        <div className="mt-14 md:ml-[25%]">
          <ul className="border-b border-line">
            {list.map((f, i) => {
              const isOpen = open === i;
              return (
                <li key={f.q} className="border-t border-line">
                  <h3>
                    <button type="button" aria-expanded={isOpen} aria-controls={`faq-${i}`} onClick={() => setOpen(isOpen ? null : i)} className="flex w-full items-center justify-between gap-6 py-6 text-left">
                      <span className="text-xl text-ink">{f.q}</span>
                      <motion.span animate={{ rotate: isOpen ? 45 : 0 }} className="shrink-0 text-ink"><Plus className="size-5" strokeWidth={1.5} /></motion.span>
                    </button>
                  </h3>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div id={`faq-${i}`} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                        <p className="max-w-2xl pb-7 leading-relaxed text-stone">{f.a}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={() => setAll((v) => !v)} className="btn btn-line mt-8 text-ink">{all ? "Show fewer" : `Show all ${faqs.length} questions`}</button>
        </div>
      </div>
    </section>
  );
}
