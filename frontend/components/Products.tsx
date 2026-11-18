import { ArrowUpRight } from "lucide-react";
import Reveal from "./Reveal";
import SectionHead from "./SectionHead";
import { productFamilies } from "@/lib/content";

export default function Products() {
  return (
    <section id="products" className="bg-paper py-24 lg:py-32">
      <div className="wrap">
        <SectionHead
          n="04"
          label="Products"
          title="What our vendors make"
          body="Four product families from vetted manufacturers across Pakistan. Standard sizes ship fast; custom size, ply and print are made to order."
        />
        <div className="mt-16 grid gap-px overflow-hidden rounded-[8px] border border-line bg-line md:grid-cols-2">
          {productFamilies.map((f, i) => (
            <Reveal key={f.id} delay={(i % 2) * 0.06} className="bg-paper">
              <article className="group flex h-full flex-col p-8 md:p-10">
                <div className="flex items-start justify-between gap-6">
                  <div>
                    <p className="font-mono text-sm text-stone">0{i + 1} / 0{productFamilies.length}</p>
                    <h3 className="mt-3 text-3xl text-ink">{f.name}</h3>
                    <p className="mt-3 max-w-sm leading-relaxed text-stone">{f.blurb}</p>
                  </div>
                  <div className="grid size-28 shrink-0 place-items-center rounded-[6px] bg-bone md:size-36">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.image} alt="" className="size-[82%] object-contain mix-blend-multiply grayscale-[.15] transition duration-500 group-hover:scale-105" loading="lazy" />
                  </div>
                </div>
                <table className="mt-8 w-full text-left">
                  <thead className="sr-only"><tr><th>Product</th><th>Typical spec</th></tr></thead>
                  <tbody>
                    {f.items.map((it) => (
                      <tr key={it.name} className="border-t border-line">
                        <td className="py-3.5 pr-4 text-[15px] text-ink">{it.name}</td>
                        <td className="py-3.5 text-right font-mono text-[13px] text-stone">{it.spec}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <a href="#contact" data-subject="Buying request" className="mt-auto inline-flex items-center gap-1.5 pt-6 text-sm font-medium text-ink hover:text-accent">
                  Request a quote <ArrowUpRight className="size-4" strokeWidth={1.5} />
                </a>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
