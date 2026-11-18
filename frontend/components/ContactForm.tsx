"use client";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Loader2, Paperclip } from "lucide-react";
import SectionHead from "./SectionHead";
import { countries, productFamilies, site, subjects } from "@/lib/content";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; id: string } | { kind: "error"; msg: string };
const subjectLabel: Record<string, string> = { "Buying request": "I want to buy", "Selling request": "I want to sell", "General inquiry": "Something else" };

export default function ContactForm() {
  const [subject, setSubject] = useState<string>(subjects[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<State>({ kind: "idle" });
  const formRef = useRef<HTMLFormElement>(null);

  // "Buy now" / "Sell now" anywhere on the page pre-selects the subject.
  useEffect(() => {
    const on = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-subject]");
      if (a?.dataset.subject) setSubject(a.dataset.subject);
    };
    document.addEventListener("click", on);
    return () => document.removeEventListener("click", on);
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.delete("files");
    files.forEach((f) => fd.append("files", f));
    setState({ kind: "sending" });
    try {
      const r = await fetch("/api/request", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Something went wrong.");
      setState({ kind: "done", id: j.id });
      formRef.current?.reset();
      setFiles([]);
    } catch (err) {
      setState({ kind: "error", msg: err instanceof Error ? err.message : "Something went wrong." });
    }
  }

  const isSell = subject === "Selling request";

  return (
    <section id="contact" className="py-24 lg:py-32">
      <div className="wrap">
        <SectionHead n="08" label="Contact" title="Secure your next deal today" body="Tell us what you need to buy or what you have to sell. An account manager replies with next steps, usually the same working day." />
        <div className="mt-14 grid gap-12 md:grid-cols-12">
          <dl className="space-y-6 md:col-span-3">
            <div><dt className="label-mono text-stone">Email</dt><dd className="mt-1"><a href={`mailto:${site.email}`} className="text-ink hover:text-accent">{site.email}</a></dd></div>
            <div><dt className="label-mono text-stone">Office</dt><dd className="mt-1 text-ink">{site.address}</dd></div>
            <div><dt className="label-mono text-stone">Hours</dt><dd className="mt-1 text-ink">Mon–Sat, 9:00–18:00 PKT</dd></div>
          </dl>

          <div className="md:col-span-9">
            <AnimatePresence mode="wait">
              {state.kind === "done" ? (
                <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-[8px] border border-line bg-paper p-10" role="status">
                  <span className="grid size-10 place-items-center rounded-full bg-accent text-white"><Check className="size-5" strokeWidth={2} /></span>
                  <h3 className="mt-6 text-3xl text-ink">Request received.</h3>
                  <p className="mt-2 max-w-md text-stone">Reference <span className="font-mono text-ink">{state.id}</span>. Your account manager will be in touch shortly.</p>
                  <button type="button" onClick={() => setState({ kind: "idle" })} className="btn btn-line mt-8 text-ink">Send another request</button>
                </motion.div>
              ) : (
                <motion.form key="form" ref={formRef} onSubmit={submit} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-5 rounded-[8px] border border-line bg-paper p-6 sm:grid-cols-2 md:p-10">
                  <fieldset className="sm:col-span-2">
                    <legend className="field-label">Subject</legend>
                    <div className="grid grid-cols-3 overflow-hidden rounded-[6px] border border-line">
                      {subjects.map((s) => (
                        <label key={s} className={`flex min-h-[46px] cursor-pointer items-center justify-center border-r border-line px-2 text-center text-sm transition-colors last:border-r-0 ${subject === s ? "bg-ink text-white" : "bg-white text-ink hover:bg-bone"}`}>
                          <input type="radio" name="subject" value={s} checked={subject === s} onChange={() => setSubject(s)} className="sr-only" />
                          {subjectLabel[s]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div><label htmlFor="first" className="field-label">First name</label><input id="first" name="firstName" required autoComplete="given-name" className="field" /></div>
                  <div><label htmlFor="last" className="field-label">Last name</label><input id="last" name="lastName" required autoComplete="family-name" className="field" /></div>
                  <div><label htmlFor="email" className="field-label">Work email</label><input id="email" name="email" type="email" required autoComplete="email" className="field" /></div>
                  <div><label htmlFor="company" className="field-label">Company</label><input id="company" name="company" required autoComplete="organization" className="field" /></div>
                  <div>
                    <label htmlFor="country" className="field-label">Country</label>
                    <select id="country" name="country" required defaultValue="" className="field">
                      <option value="" disabled>Select a country</option>
                      {countries.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="family" className="field-label">Product</label>
                    {isSell ? <>
                      <input id="family" name="product" list="supplier-products" maxLength={120} placeholder="e.g. Corrugated Boxes" className="field" />
                      <datalist id="supplier-products">{productFamilies.flatMap((family) => family.items.map((item) => <option key={`${family.id}-${item.name}`} value={`${family.name} · ${item.name}`} />))}</datalist>
                    </> :
                    <select id="family" name="product" defaultValue="" className="field">
                      <option value="">Not sure yet</option>
                      {productFamilies.map((f) => (
                        <optgroup key={f.id} label={f.name}>
                          {f.items.map((i) => <option key={i.name} value={`${f.name} · ${i.name}`}>{i.name}</option>)}
                        </optgroup>
                      ))}
                    </select>}
                  </div>
                  {isSell && <div><label htmlFor="city" className="field-label">City</label><input id="city" name="city" maxLength={100} autoComplete="address-level2" className="field" /></div>}
                  <div><label htmlFor="qty" className="field-label">{isSell ? "Monthly capacity / stock" : "Quantity"}</label><input id="qty" name="quantity" placeholder={isSell ? "e.g. 200,000 pcs / month" : "e.g. 20,000 pcs"} className="field" /></div>
                  <div className="sm:col-span-2">
                    <label htmlFor="msg" className="field-label">{isSell ? "What do you make?" : "What do you need?"}</label>
                    <textarea id="msg" name="message" rows={4} required placeholder={isSell ? "Products, machines, ply range, certifications…" : "Size, ply, GSM, print, destination port, target date…"} className="field resize-y" />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="files" className="flex cursor-pointer items-center gap-3 rounded-[6px] border border-dashed border-line bg-white px-4 py-4 text-sm text-stone transition-colors hover:border-ink">
                      <Paperclip className="size-4 text-ink" strokeWidth={1.5} />
                      <span>{files.length ? files.map((f) => f.name).join(", ") : <>Attach spec sheets, stock lists or photos <span className="text-fog">· Excel, PDF, CSV, images · 10 MB max</span></>}</span>
                    </label>
                    <input id="files" name="files" type="file" multiple accept=".xls,.xlsx,.csv,.pdf,.png,.jpg,.jpeg,.webp" className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
                  </div>
                  <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
                  <div className="flex flex-wrap items-center gap-4 border-t border-line pt-6 sm:col-span-2">
                    <button type="submit" disabled={state.kind === "sending"} className="btn btn-accent min-w-44 disabled:opacity-70">
                      {state.kind === "sending" ? <><Loader2 className="size-4 animate-spin" /> Sending…</> : <>Send request <ArrowRight className="arrow size-4" strokeWidth={1.75} /></>}
                    </button>
                    {state.kind === "error" && <p role="alert" className="text-sm text-accent-deep">{state.msg}</p>}
                  </div>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
