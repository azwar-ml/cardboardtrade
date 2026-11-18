import { productFamilies } from "@/lib/content";

const items = productFamilies.flatMap((f) => f.items);

export default function ProductMarquee() {
  const row = [...items, ...items];
  return (
    <section aria-label="Products available for export" className="border-y border-white/10 bg-ink py-5 text-white">
      <div className="flex items-center gap-8">
        <p className="label-mono hidden shrink-0 pl-10 text-white/40 lg:block">Available for export</p>
        <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_6%,#000_94%,transparent)]">
          <ul className="marquee-track flex w-max items-center">
            {row.map((it, i) => (
              <li key={i} aria-hidden={i >= items.length} className="flex items-center gap-8 pr-8 text-[15px] text-white/75">
                {it.name}
                <span className="size-1 rounded-full bg-accent" aria-hidden />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
