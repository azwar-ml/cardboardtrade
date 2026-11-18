"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Play, X } from "lucide-react";
import { hero, promise } from "@/lib/content";

const ease = [0.22, 1, 0.36, 1] as const;

export default function Hero() {
  const [playing, setPlaying] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!playing) return;
    closeRef.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && setPlaying(false);
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [playing]);

  const rise = (d: number) => ({ initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.8, delay: d, ease } });

  return (
    <section id="top" className="relative isolate overflow-hidden bg-ink text-white">
      <video
        className="absolute inset-0 -z-20 size-full object-cover"
        src="/video/hero-reel.mp4"
        poster="/video/hero-poster.jpg"
        autoPlay={!reduce}
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <div className="absolute inset-0 -z-10 bg-ink/55" />
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(14,16,19,.85)_0%,rgba(14,16,19,.35)_60%,rgba(14,16,19,.2)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-gradient-to-t from-ink to-transparent" />

      <div className="wrap flex min-h-[100svh] flex-col justify-end pb-10 pt-32">
        <motion.p {...rise(0)} className="label-mono text-white/60">
          <span className="mr-2 inline-block size-1.5 translate-y-[-1px] rounded-full bg-accent align-middle" />
          {hero.eyebrow}
        </motion.p>
        <motion.h1 {...rise(0.08)} className="mt-6 max-w-[14ch] text-[clamp(3rem,8vw,7.5rem)] leading-[1.05] tracking-[-0.025em]">
          {hero.title}
        </motion.h1>

        <div className="mt-10 grid gap-8 md:grid-cols-12 md:items-end">
          <motion.p {...rise(0.16)} className="max-w-xl text-lg leading-relaxed text-white/75 md:col-span-6">
            {hero.body}
          </motion.p>
          <motion.div {...rise(0.24)} className="flex flex-wrap gap-3 md:col-span-6 md:justify-end">
            <a href="#contact" data-subject="Buying request" className="btn btn-accent">Buy now <ArrowRight className="arrow size-4" strokeWidth={1.75} /></a>
            <a href="#contact" data-subject="Selling request" className="btn btn-light">Sell now <ArrowRight className="arrow size-4" strokeWidth={1.75} /></a>
          </motion.div>
        </div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.5 }} className="rule-dark mt-12 grid grid-cols-2 gap-6 pt-6 md:grid-cols-12">
          {promise.map((p) => (
            <div key={p.label} className="md:col-span-2">
              <p className="font-display text-3xl tabular-nums tracking-[-0.03em]">{p.value}</p>
              <p className="label-mono mt-1 text-white/50">{p.label}</p>
            </div>
          ))}
          <button type="button" onClick={() => setPlaying(true)} className="group col-span-2 flex items-center gap-4 text-left md:col-span-4 md:col-start-9 md:justify-self-end">
            <span className="relative block h-16 w-28 shrink-0 overflow-hidden rounded-[4px] ring-1 ring-white/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/video/poster.jpg" alt="" className="size-full object-cover transition duration-500 group-hover:scale-105" />
              <span className="absolute inset-0 grid place-items-center bg-ink/30">
                <span className="grid size-8 place-items-center rounded-full bg-white text-ink"><Play className="ml-0.5 size-3.5 fill-ink" /></span>
              </span>
            </span>
            <span>
              <span className="block font-medium">Watch the film</span>
              <span className="label-mono text-white/50">0:53 · How it works</span>
            </span>
          </button>
        </motion.div>
      </div>

      <AnimatePresence>
        {playing && (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Cardboard Package film"
            className="fixed inset-0 z-[80] grid place-items-center bg-ink/95 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPlaying(false)}
          >
            <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.98, opacity: 0 }} transition={{ duration: 0.4, ease }} className="relative w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
              <button ref={closeRef} type="button" onClick={() => setPlaying(false)} className="absolute -top-14 right-0 grid size-11 place-items-center text-white/80 hover:text-white" aria-label="Close film">
                <X strokeWidth={1.5} />
              </button>
              <video src="/video/cardboard-package-film.mp4" poster="/video/poster.jpg" controls autoPlay playsInline className="aspect-video w-full rounded-[6px] bg-black" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
