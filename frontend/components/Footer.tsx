import { ArrowRight } from "lucide-react";
import Logo from "./Logo";
import { nav, site } from "@/lib/content";

export default function Footer() {
  return (
    <footer className="bg-ink text-bone">
      <div className="wrap">
        <div className="grid gap-8 py-20 md:grid-cols-12 md:items-end">
          <h2 className="text-[2.6rem] leading-[1.05] tracking-[-0.025em] md:col-span-8 md:text-[5rem]">Buy and sell cardboard effortlessly.</h2>
          <div className="flex flex-wrap gap-3 md:col-span-4 md:justify-end">
            <a href="#contact" data-subject="Buying request" className="btn btn-accent">Buy now <ArrowRight className="arrow size-4" strokeWidth={1.75} /></a>
            <a href="#contact" data-subject="Selling request" className="btn btn-light">Sell now <ArrowRight className="arrow size-4" strokeWidth={1.75} /></a>
          </div>
        </div>
        <div className="rule-dark grid gap-10 py-12 md:grid-cols-12">
          <div className="md:col-span-6">
            <Logo light />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fog">{site.tagline}</p>
          </div>
          <nav aria-label="Footer" className="md:col-span-3">
            <p className="label-mono text-fog">Explore</p>
            <ul className="mt-4 space-y-2.5 text-bone/85">
              {nav.map((n) => <li key={n.href}><a href={n.href} className="hover:text-white">{n.label}</a></li>)}
            </ul>
          </nav>
          <div className="md:col-span-3">
            <p className="label-mono text-fog">Contact</p>
            <ul className="mt-4 space-y-2.5 text-bone/85">
              <li><a href={`mailto:${site.email}`} className="hover:text-white">{site.email}</a></li>
              <li>{site.address}</li>
            </ul>
          </div>
        </div>
        <div className="rule-dark flex flex-col gap-2 py-6 text-xs text-fog sm:flex-row sm:justify-between">
          <p>© {new Date().getFullYear()} Cardboard Package · Lahore, Pakistan</p>
          <p>Photography: Unsplash · Video: Mixkit</p>
        </div>
      </div>
    </footer>
  );
}
