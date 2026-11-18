"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FileSearch,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { PageHead, Panel, Pill, Stat } from "./ui";

type Finding = {
  category: string;
  claim: string;
  result: string;
  explanation: string;
  source_urls: string[];
  checked_at: string;
  next_action: string;
  manual_reference_urls: string[];
};
type Source = {
  id: string;
  url: string;
  observed_at: string;
  text: string;
  kind: string;
};
type Price = {
  id: number;
  reference: {
    description: string;
    specification: Record<string, string>;
    amount: string;
    currency: string;
    price_unit: string;
    pieces_per_unit: number;
    moq: number | null;
    tier_min: number;
    tier_max: number | null;
    channel: string;
    price_kind: string;
    source_url: string;
    observed_at: string;
    delivery_terms: string;
  };
};
type AIResult = {
  status: string;
  key_name?: string;
  model?: string;
  reason?: string;
  analysis?: Record<
    string,
    { value: string; evidence_id: string; quote: string }[]
  >;
};
type Report = {
  market_observations?: { source_url: string; observed_at: string; published_price: string; quote: string; comparability: string }[];
  provisional_prices?: Price["reference"][];
  summary: string;
  findings: Finding[];
  evidence_coverage: number;
  risk_flags: string[];
  recommendation: string;
  score_explanation: string;
  evidence: Source[];
  research_errors: string[];
  ai: AIResult;
  ai_workloads?: Record<string, AIResult>;
  comparison?: { status: string };
  market_references: Price[];
};
type Supplier = {
  id: number;
  company: string;
  city: string;
  status: string;
  evaluation_id: number | null;
  evaluation_status: string | null;
  report: Report | null;
  review_status: string | null;
};
type Job = {
  id: number;
  status: string;
  error: string | null;
  report: Report | null;
  review_status: string;
  review_note: string;
};
type Summary = {
  ai_configuration?: {
    workloads: {
      workload: string;
      key_name: string;
      configured: boolean;
      conditional: boolean;
      disabled?: boolean;
    }[];
  };
  ai_blocked_reason?: string | null;
  pending: number;
  completed: number;
  active: number;
  benchmarks: number;
  automation: { auto_enabled: number; batch_size: number };
  ai_usage: {
    id: number;
    purpose: string;
    model: string | null;
    status: string;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: string | null;
    error: string | null;
    key_name?: string | null;
    workload?: string | null;
  }[];
};
type Comparison = {
  status: string;
  currency: string;
  range: { low: string; high: string } | null;
  matched: {
    id: number;
    reference: Price["reference"];
    price_per_piece: string;
    known_total_per_piece: string;
    missing_cost_components: string[];
    unusual_price: boolean;
  }[];
  excluded: { id: number; reasons: string[]; reference: Price["reference"] }[];
  cost_basis: string;
};

const inputClass =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-accent focus:outline-none";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:border-accent disabled:opacity-50";
const specFields = [
  "packaging_type",
  "dimensions_mm",
  "material",
  "flute",
  "ply",
  "printing",
  "finishing",
];
const labels: Record<string, string> = {
  packaging_type: "Packaging type",
  dimensions_mm: "Dimensions in mm (L × W × H)",
  material: "Material",
  flute: "Flute",
  ply: "Ply",
  printing: "Printing",
  finishing: "Finishing",
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/console/qualification/${path}`, {
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check the required fields and source evidence.",
    );
  return data;
}

function SourceLink({ url }: { url: string }) {
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 break-all text-sm text-accent underline underline-offset-2"
    >
      {url}
      <ExternalLink size={12} className="shrink-0" />
    </a>
  );
}

export default function SupplierQualification() {
  const [tab, setTab] = useState("Supplier Verification");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [research, setResearch] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [urls, setUrls] = useState("");
  const [specification, setSpecification] = useState<Record<string, string>>(
    {},
  );
  const [quantity, setQuantity] = useState(1000);
  const [currency, setCurrency] = useState("PKR");
  const [channel, setChannel] = useState("wholesale");
  const [priceKind, setPriceKind] = useState("advertised");
  const [rates, setRates] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [priceEntry, setPriceEntry] = useState("");
  const [page, setPage] = useState(1);
  const refresh = useCallback(async () => {
    try {
      const [status, leads, benchmarks, recentJobs] = await Promise.all([
        api<Summary>("summary"),
        api<{ items: Supplier[] }>(`suppliers?page=${page}`),
        api<{ items: Price[] }>("market/prices"),
        api<{ items: Job[] }>("jobs"),
      ]);
      setSummary(status);
      setSuppliers(leads.items);
      setPrices(benchmarks.items);
      setJobs(recentJobs.items);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Agent #2");
    }
  }, [page]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const selectedId = selected?.id;
  const selectedStatus = selected?.status;
  useEffect(() => {
    if (!selectedId || !["Queued", "Running"].includes(selectedStatus || ""))
      return;
    let active = true;
    const timer = setInterval(() => {
      void api<Job>(`jobs/${selectedId}`)
        .then((job) => {
          if (active) setSelected(job);
        })
        .catch((err) => {
          if (active)
            setError(
              err instanceof Error
                ? err.message
                : "Could not refresh evaluation",
            );
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedId, selectedStatus]);
  useEffect(() => {
    if (!selectedId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selectedId]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  async function openJob(id: number) {
    const job = await api<Job>(`jobs/${id}`);
    setSelected(job);
    setReviewNote(job.review_note || "");
  }
  async function evaluate(lead: Supplier) {
    await action(async () => {
      const result = await api<{ id: number; reused: boolean }>(
        `suppliers/${lead.id}/evaluate`,
        { ai: true, research, search, source_urls: [] },
      );
      setNotice(
        `Evaluation #${result.id} ${result.reused ? "reused saved evidence" : "queued"}.`,
      );
    });
  }

  const report = selected?.report;
  return (
    <article data-testid="qualification-dashboard">
      <PageHead
        title="Supplier Verification & Market Prices"
        sub="Evidence-based evaluation with final Admin review."
      >
        <Pill tone="good">
          <ShieldCheck size={13} className="mr-1" />
          Live
        </Pill>
        <button className={buttonClass} onClick={() => void refresh()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </PageHead>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          {error}
          <button className="ml-3 underline" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-accent">
          {notice}
        </p>
      )}
      {!summary && !error && (
        <p role="status" className="py-8 text-stone">
          Loading supplier evaluations…
        </p>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pending review" value={summary?.pending ?? "—"} />
        <Stat label="Evaluations completed" value={summary?.completed ?? "—"} />
        <Stat label="In progress" value={summary?.active ?? "—"} />
        <Stat label="Market references" value={summary?.benchmarks ?? "—"} />
      </div>
      <div
        role="tablist"
        aria-label="Qualification workflows"
        className="mb-5 flex gap-5 border-b border-line"
      >
        {["Supplier Verification", "Market Prices"].map((name) => (
          <button
            role="tab"
            aria-selected={tab === name}
            key={name}
            className={`border-b-2 py-3 text-sm ${tab === name ? "border-accent font-semibold text-accent" : "border-transparent text-stone"}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "Supplier Verification" ? (
        <section
          role="tabpanel"
          aria-label="Supplier Verification"
          className="space-y-4"
        >
          <Panel className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div>
              <h2 className="font-semibold">Evaluation controls</h2>
              <p className="mt-1 text-xs text-stone">
                Saved evidence is reused. Optional research follows source
                permissions and the shared search budget.
              </p>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label>
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => {
                    setResearch(e.target.checked);
                    if (!e.target.checked) setSearch(false);
                  }}
                />{" "}
                Research permitted pages
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={search}
                  disabled={!research}
                  onChange={(e) => setSearch(e.target.checked)}
                />{" "}
                One DuckDuckGo search
              </label>
            </div>
          </Panel>
          <Panel className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-bone text-xs text-stone">
                <tr>
                  {[
                    "Supplier",
                    "City",
                    "Evaluation",
                    "Coverage",
                    "Admin review",
                    "",
                  ].map((h, i) => (
                    <th key={i} className="px-4 py-3 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {suppliers.map((lead) => (
                  <tr key={lead.id} className="border-t border-line">
                    <td className="px-4 py-4 font-medium">
                      {lead.evaluation_id ? (
                        <button
                          className="text-accent hover:underline"
                          onClick={() =>
                            void action(() => openJob(lead.evaluation_id!))
                          }
                        >
                          {lead.company}
                        </button>
                      ) : (
                        lead.company
                      )}
                      <p className="mt-1 text-xs font-normal text-stone">
                        {lead.status}
                      </p>
                    </td>
                    <td className="px-4 py-4">{lead.city || "Unknown"}</td>
                    <td className="px-4 py-4">
                      <Pill
                        tone={
                          lead.evaluation_status === "Failed" ? "bad" : "info"
                        }
                      >
                        {lead.evaluation_status || "Awaiting evaluation"}
                      </Pill>
                    </td>
                    <td className="px-4 py-4">
                      {lead.report ? (
                        <>
                          <span>{lead.report.evidence_coverage}%</span>
                          <p className="mt-1 text-xs text-stone">
                            {lead.report.risk_flags.length} open checks
                          </p>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs">
                      {lead.review_status || "Pending"}
                    </td>
                    <td className="px-4 py-4">
                      <button
                        disabled={
                          busy ||
                          ["Running", "Queued"].includes(
                            lead.evaluation_status || "",
                          )
                        }
                        className={buttonClass}
                        onClick={() => void evaluate(lead)}
                      >
                        <FileSearch size={14} />
                        Evaluate Now
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!suppliers.length && summary && (
              <p className="p-8 text-center text-sm text-stone">
                No suppliers awaiting evaluation. New Agent #1 leads will appear
                here.
              </p>
            )}
          </Panel>
          <div className="flex justify-between">
            <button
              className={buttonClass}
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <span className="p-2 text-sm text-stone">Page {page}</span>
            <button
              className={buttonClass}
              disabled={suppliers.length < 20}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
          <details className="rounded-lg border border-line bg-paper p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Automatic saved-evidence queue
            </summary>
            <p className="my-3 text-sm text-stone">
              Evaluates new Pending Review suppliers in batches of{" "}
              {summary?.automation.batch_size ?? 2}. Automatic jobs use
              deterministic rules and saved evidence.
            </p>
            <button
              className={buttonClass}
              disabled={busy || !summary}
              onClick={() =>
                void action(async () => {
                  await api("automation", {
                    enabled: !summary?.automation.auto_enabled,
                    batch_size: 2,
                  });
                })
              }
            >
              {summary?.automation.auto_enabled
                ? "Pause automatic evaluation"
                : "Enable automatic evaluation"}
            </button>
          </details>
        </section>
      ) : (
        <section
          role="tabpanel"
          aria-label="Market Prices"
          className="space-y-5"
        >
          <Panel className="p-5">
            <h2 className="mb-4 font-semibold">
              Compare packaging specifications
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  setComparison(
                    await api<Comparison>("market/compare", {
                      specification,
                      quantity,
                      currency,
                      channel,
                      price_kind: priceKind,
                      exchange_rates: rates.trim() ? JSON.parse(rates) : [],
                    }),
                  );
                });
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {specFields.map((field) => (
                  <label className="text-xs text-stone" key={field}>
                    {labels[field]}
                    <input
                      required
                      className={`${inputClass} mt-1`}
                      value={specification[field] || ""}
                      onChange={(e) =>
                        setSpecification({
                          ...specification,
                          [field]: e.target.value,
                        })
                      }
                    />
                  </label>
                ))}
                <label className="text-xs text-stone">
                  Quantity
                  <input
                    required
                    type="number"
                    min="1"
                    max="100000000"
                    className={`${inputClass} mt-1`}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </label>
                <label className="text-xs text-stone">
                  Comparison currency
                  <input
                    required
                    pattern="[A-Z]{3}"
                    className={`${inputClass} mt-1`}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                </label>
                <label className="text-xs text-stone">
                  Market channel
                  <select
                    className={`${inputClass} mt-1`}
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                  >
                    <option>wholesale</option>
                    <option>retail</option>
                  </select>
                </label>
                <label className="text-xs text-stone">
                  Price evidence
                  <select
                    className={`${inputClass} mt-1`}
                    value={priceKind}
                    onChange={(e) => setPriceKind(e.target.value)}
                  >
                    <option>advertised</option>
                    <option>estimated</option>
                    <option>confirmed quotation</option>
                  </select>
                </label>
              </div>
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-stone">
                  Sourced exchange rates
                </summary>
                <p className="my-2 text-xs text-stone">
                  Provide a JSON array with currency, target_currency, rate,
                  source_url and observed_at for each conversion.
                </p>
                <textarea
                  aria-label="Sourced exchange rates JSON"
                  className={inputClass}
                  rows={3}
                  value={rates}
                  onChange={(e) => setRates(e.target.value)}
                />
              </details>
              <button
                className={`${buttonClass} mt-4 bg-ink text-white`}
                disabled={busy}
              >
                Compare Prices
              </button>
            </form>
          </Panel>
          {comparison && (
            <Panel className="p-5">
              <h2 className="font-semibold">{comparison.status}</h2>
              {comparison.range && (
                <p className="mt-2 text-2xl">
                  {comparison.currency} {comparison.range.low} –{" "}
                  {comparison.range.high}{" "}
                  <span className="text-sm text-stone">per piece</span>
                </p>
              )}
              <p className="my-3 text-xs text-stone">{comparison.cost_basis}</p>
              {comparison.matched.map((item) => (
                <div key={item.id} className="border-t border-line py-3">
                  <p className="text-sm font-medium">
                    {item.reference.description} · {item.price_per_piece}{" "}
                    {comparison.currency}/piece{" "}
                    {item.unusual_price && (
                      <Pill tone="warn">Unusual price</Pill>
                    )}
                  </p>
                  <p className="my-1 text-xs text-stone">
                    Known costs included {item.known_total_per_piece}/piece ·
                    Missing costs{" "}
                    {item.missing_cost_components.join(", ") || "None"}
                  </p>
                  <SourceLink url={item.reference.source_url} />
                </div>
              ))}
              {!!comparison.excluded.length && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm">
                    Excluded references ({comparison.excluded.length})
                  </summary>
                  {comparison.excluded.map((item) => (
                    <div key={item.id} className="py-3 text-sm">
                      <p>{item.reference.description}</p>
                      <p className="text-xs text-stone">
                        {item.reasons.join(" · ")}
                      </p>
                      <SourceLink url={item.reference.source_url} />
                    </div>
                  ))}
                </details>
              )}
            </Panel>
          )}
          {jobs.some(job => job.report?.market_observations?.length) && <Panel className="p-5">
            <h2 className="font-semibold">Published prices requiring specification checks</h2>
            {jobs.flatMap(job => job.report?.market_observations || []).map((observation, index) => <details key={`${observation.source_url}-${index}`} className="mt-3 border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-medium">{observation.published_price}</summary>
              <p className="my-2 text-xs text-stone">{observation.comparability}</p>
              <p className="my-2 text-xs text-stone">Observed {observation.observed_at}</p>
              <SourceLink url={observation.source_url} />
              <p className="mt-2 whitespace-pre-wrap text-sm">{observation.quote}</p>
            </details>)}
          </Panel>}
          <Panel className="p-5">
            <h2 className="font-semibold">Source-backed benchmarks</h2>
            {prices.length === 0 ? (
              <p className="mt-3 text-sm text-stone">
                Insufficient Comparable Data. Research permitted public pages or
                add an evidence-backed price reference.
              </p>
            ) : (
              prices.map((price) => (
                <div key={price.id} className="mt-3 border-t border-line pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {price.reference.description}
                    </p>
                    <Pill>
                      {price.reference.channel} · {price.reference.price_kind}
                    </Pill>
                  </div>
                  <p className="my-2 text-sm">
                    {price.reference.amount} {price.reference.currency} /{" "}
                    {price.reference.price_unit} · MOQ{" "}
                    {price.reference.moq ?? "unknown"} ·{" "}
                    {price.reference.pieces_per_unit} pieces per unit
                  </p>
                  <p className="mb-2 text-xs text-stone">
                    {Object.values(price.reference.specification).join(" · ")} ·{" "}
                    {price.reference.delivery_terms || "Delivery terms unknown"}{" "}
                    · Observed {price.reference.observed_at}
                  </p>
                  <SourceLink url={price.reference.source_url} />
                </div>
              ))
            )}
          </Panel>
          <details className="rounded-lg border border-line bg-paper p-5">
            <summary className="cursor-pointer font-medium">
              Research market sources
            </summary>
            <p className="my-3 text-sm text-stone">
              Public prices from Pakistani manufacturers, Alibaba, Made-in-China
              and Amazon Business are available when permitted. Each request
              uses the shared source policy and search budget.
            </p>
            <label className="block text-xs text-stone">
              Product research query
              <input
                className={`${inputClass} mt-1`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="mt-3 block text-xs text-stone">
              Permitted source URLs, one per line
              <textarea
                className={`${inputClass} mt-1`}
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                rows={3}
              />
            </label>
            <label className="my-3 block text-sm">
              <input
                type="checkbox"
                checked={search}
                onChange={(e) => setSearch(e.target.checked)}
              />{" "}
              Use one DuckDuckGo search
            </label>
            <button
              className={buttonClass}
              disabled={busy || query.trim().length < 3}
              onClick={() =>
                void action(async () => {
                  const result = await api<{ id: number }>("market/research", {
                    query,
                    research: true,
                    search,
                    ai: true,
                    source_urls: urls
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  });
                  setNotice(`Market research #${result.id} queued.`);
                })
              }
            >
              Research Sources
            </button>
          </details>
          <details
            className="rounded-lg border border-line bg-paper p-5"
            open={Boolean(priceEntry)}
          >
            <summary className="cursor-pointer text-sm font-medium">
              Confirm a retrieved price reference
            </summary>
            <p className="my-3 text-xs text-stone">
              Paste a JSON object containing job_id and reference. The reference
              requires evidence_id, source_url, source_quote, observed_at,
              description, specification, amount, currency, channel and
              price_kind. Quotes and dates must match a retrieved source in that
              job. Shipping, tax and other_cost are totals for the requested
              order in the source currency.
            </p>
            <textarea
              aria-label="Source-backed price JSON"
              rows={8}
              className={`${inputClass} font-mono`}
              value={priceEntry}
              onChange={(e) => setPriceEntry(e.target.value)}
            />
            <button
              className={`${buttonClass} mt-3`}
              disabled={busy || !priceEntry.trim()}
              onClick={() =>
                void action(async () => {
                  await api("market/prices", JSON.parse(priceEntry));
                  setNotice("Evidence-backed price reference saved.");
                })
              }
            >
              Save Price Reference
            </button>
          </details>
          {!!jobs.length && (
            <Panel className="p-4">
              <h2 className="mb-3 text-sm font-semibold">
                Recent evaluations and source research
              </h2>
              <div className="flex flex-wrap gap-2">
                {jobs.slice(0, 15).map((job) => (
                  <button
                    key={job.id}
                    className={buttonClass}
                    onClick={() => void action(() => openJob(job.id))}
                  >
                    Report #{job.id} · {job.status}
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </section>
      )}
      <details className="mt-5 rounded-lg border border-line bg-paper p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Gemini usage and availability
        </summary>
        <p className="my-3 text-xs text-stone">
          Supplier verification uses key #1. Market analysis uses key #2.
          Cost figures are estimates at published paid-tier rates.
          Account charges depend on the project tier.
        </p>
        {summary?.ai_configuration?.workloads.map((item) => (
          <p className="mb-2 text-xs text-stone" key={item.workload}>
            {item.key_name} · {item.workload} ·{" "}
            {item.disabled ? "Disabled" : item.configured ? "Configured" : "Unavailable"}
            {item.conditional && !item.disabled ? " · Used when needed" : ""}
          </p>
        ))}
        {summary?.ai_blocked_reason && (
          <p className="my-2 text-xs text-red-800">
            All AI workloads paused · {summary.ai_blocked_reason}
          </p>
        )}
        {summary?.ai_usage.length ? (
          summary.ai_usage.slice(0, 12).map((usage) => (
            <p className="mb-2 break-words text-xs text-stone" key={usage.id}>
              {usage.key_name ? `${usage.key_name} · ` : ""}
              {usage.model || "Model unavailable"} · {usage.status} ·{" "}
              {usage.input_tokens} input / {usage.output_tokens} output tokens ·{" "}
              {usage.estimated_cost_usd === null
                ? "Cost unknown"
                : `$${usage.estimated_cost_usd}`}{" "}
              {usage.error}
            </p>
          ))
        ) : (
          <p className="text-sm text-stone">
            No Gemini usage has been recorded for this database.
          </p>
        )}
      </details>
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8"
          onClick={() => setSelected(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Supplier evaluation details"
            className="my-4 w-full max-w-4xl rounded-xl border border-line bg-paper p-5 shadow-xl sm:p-7"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">
                Evaluation #{selected.id}
              </h2>
              <button className={buttonClass} onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
            <Pill>{selected.status}</Pill>
            {selected.error && (
              <p role="alert" className="mt-3 text-sm text-red-800">
                {selected.error}
              </p>
            )}
            {report ? (
              <>
                <p className="mt-4 text-sm leading-6">{report.summary}</p>
                <div className="my-4 flex flex-wrap gap-2">
                  <Pill>
                    Evidence coverage {report.evidence_coverage ?? "—"}%
                  </Pill>
                  <Pill
                    tone={report.ai.status === "Available" ? "good" : "warn"}
                  >
                    AI analysis {report.ai.status.toLowerCase()}
                  </Pill>
                </div>
                {report.ai.reason && (
                  <p className="mb-3 text-xs text-stone">{report.ai.reason}</p>
                )}
                <p className="text-xs text-stone">{report.score_explanation}</p>
                <h3 className="mb-3 mt-6 font-semibold">
                  Verification findings
                </h3>
                {report.findings.map((finding) => (
                  <details
                    key={finding.category}
                    className="mb-2 rounded-lg border border-line p-3"
                  >
                    <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm capitalize">
                      {finding.category}
                      <Pill
                        tone={
                          finding.result === "Supported"
                            ? "good"
                            : finding.result === "Conflicting"
                              ? "bad"
                              : "warn"
                        }
                      >
                        {finding.result}
                      </Pill>
                    </summary>
                    <p className="mt-3 text-sm">{finding.claim}</p>
                    <p className="my-2 text-sm text-stone">
                      {finding.explanation}
                    </p>
                    {finding.source_urls.map((url) => (
                      <div key={url}>
                        <SourceLink url={url} />
                      </div>
                    ))}
                    <p className="my-2 text-xs text-stone">
                      Checked {finding.checked_at}
                    </p>
                    <p className="text-sm">{finding.next_action}</p>
                    {finding.manual_reference_urls.map((url) => (
                      <div key={url}>
                        <SourceLink url={url} />
                      </div>
                    ))}
                  </details>
                ))}
                <details className="mt-5 rounded-lg border border-line p-4">
                  <summary className="cursor-pointer font-medium">
                    Evidence sources ({report.evidence.length})
                  </summary>
                  {report.evidence.map((source) => (
                    <div
                      className="mt-4 border-t border-line pt-3"
                      key={source.id}
                    >
                      <Pill>
                        {source.kind === "supplier"
                          ? "Supplier claim"
                          : source.kind === "independent"
                            ? "Independent public reference"
                            : source.kind}
                      </Pill>
                      <p className="my-2 text-xs text-stone">
                        {source.id} · {source.observed_at}
                      </p>
                      <SourceLink url={source.url} />
                      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-stone">
                        {source.text}
                      </p>
                    </div>
                  ))}
                </details>
                {Object.entries(
                  report.ai_workloads || { supplier: report.ai },
                ).map(([workload, result]) => (
                  <details
                    key={workload}
                    className="mt-4 rounded-lg border border-line p-4"
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      Source-linked Gemini annotations · {workload} ·{" "}
                      {result.status}
                    </summary>
                    <p className="my-2 text-xs text-stone">
                      {result.key_name} {result.reason}
                    </p>
                    {Object.entries(result.analysis || {})
                      .filter(([field]) => field !== "prices")
                      .map(([field, points]) => (
                        <div key={field} className="mt-3">
                          <h4 className="text-sm capitalize">
                            {field.replaceAll("_", " ")}
                          </h4>
                          {points.map((point, index) => (
                            <p key={index} className="mt-1 text-xs text-stone">
                              {point.value} · {point.evidence_id} · “
                              {point.quote}”
                            </p>
                          ))}
                        </div>
                      ))}
                  </details>
                ))}
                {!!report.provisional_prices?.length && (
                  <details className="mt-4 rounded-lg border border-line p-4">
                    <summary className="cursor-pointer text-sm font-medium">
                      Provisional extracted prices requiring Admin confirmation
                    </summary>
                    {report.provisional_prices.map((price, index) => (
                      <div
                        key={index}
                        className="mt-3 border-t border-line pt-3"
                      >
                        <p className="text-sm">
                          {price.description} · {price.amount} {price.currency}
                        </p>
                        <SourceLink url={price.source_url} />
                        <button
                          className={`${buttonClass} mt-2`}
                          onClick={() => {
                            setPriceEntry(
                              JSON.stringify(
                                { job_id: selected.id, reference: price },
                                null,
                                2,
                              ),
                            );
                            setTab("Market Prices");
                            setSelected(null);
                          }}
                        >
                          Review Price Reference
                        </button>
                      </div>
                    ))}
                  </details>
                )}
                <details className="mt-4 rounded-lg border border-line p-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    Market references and open checks
                  </summary>
                  <p className="my-3 text-sm">
                    {report.comparison?.status ||
                      "Open the Market Prices tab to compare specifications."}
                  </p>
                  {report.market_references?.map((price) => (
                    <div className="mb-2" key={price.id}>
                      <p className="text-sm">
                        {price.reference.description} · {price.reference.amount}{" "}
                        {price.reference.currency}
                      </p>
                      <SourceLink url={price.reference.source_url} />
                    </div>
                  ))}
                  {report.risk_flags.map((flag) => (
                    <p className="mt-2 text-xs text-stone" key={flag}>
                      {flag}
                    </p>
                  ))}
                  {report.research_errors.map((message, index) => (
                    <p className="mt-2 text-xs text-red-800" key={index}>
                      {message}
                    </p>
                  ))}
                </details>
                <p className="mt-5 text-sm">{report.recommendation}</p>
                <div className="mt-5 border-t border-line pt-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <CheckCircle2 size={16} />
                    Admin review · {selected.review_status}
                  </h3>
                  <label className="text-xs text-stone">
                    Review note
                    <textarea
                      className={`${inputClass} mt-1`}
                      rows={3}
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                    />
                  </label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {["Reviewed", "Documents Requested", "Rejected"].map(
                      (status) => (
                        <button
                          disabled={
                            busy ||
                            !reviewNote.trim() ||
                            selected.status !== "Completed"
                          }
                          className={buttonClass}
                          key={status}
                          onClick={() =>
                            void action(async () => {
                              await api(`jobs/${selected.id}/review`, {
                                status,
                                note: reviewNote,
                              });
                              await openJob(selected.id);
                            })
                          }
                        >
                          {status}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="my-5 text-sm text-stone">
                {selected.status === "Failed"
                  ? "Evaluation failed. Review the error and retry the evaluation."
                  : "The report will appear when evaluation completes."}
              </p>
            )}
          </section>
        </div>
      )}
    </article>
  );
}
