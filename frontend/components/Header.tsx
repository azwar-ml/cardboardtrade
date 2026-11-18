"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Menu, X } from "lucide-react";
import Logo from "./Logo";
import { nav } from "@/lib/content";

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);

  const solid = scrolled || open;
  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${solid ? "border-b border-line bg-bone/92 backdrop-blur-md" : "border-b border-white/10 bg-transparent"}`}>
      <div className="wrap flex h-[68px] items-center justify-between gap-6">
        <a href="#top" aria-label="Cardboard Package, back to top"><Logo light={!solid} /></a>
        <nav aria-label="Main" className="hidden items-center gap-9 md:flex">
          {nav.map((n) => (
            <a key={n.href} href={n.href} className={`text-[14px] transition-colors ${solid ? "text-stone hover:text-ink" : "text-white/70 hover:text-white"}`}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <a href="#contact" className={`btn hidden !h-10 sm:inline-flex ${solid ? "btn-ink" : "btn-light"}`}>Contact us</a>
          <button
            type="button"
            className={`grid size-11 place-items-center md:hidden ${solid ? "text-ink" : "text-white"}`}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X strokeWidth={1.5} /> : <Menu strokeWidth={1.5} />}
          </button>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.nav id="mobile-nav" aria-label="Mobile" initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden border-t border-line bg-bone md:hidden">
            <div className="wrap flex flex-col py-2">
              {[...nav, { href: "#contact", label: "Contact us" }].map((n) => (
                <a key={n.href} href={n.href} onClick={() => setOpen(false)} className="border-b border-line py-4 text-lg text-ink last:border-0">{n.label}</a>
              ))}
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
