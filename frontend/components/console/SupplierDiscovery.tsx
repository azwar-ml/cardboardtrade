"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, Pill } from "./ui";

type Match = { kind: string; id: number; name: string; reasons: string[] };
type Source = { id: number; source_type: string; url: string; enquiry_id: string | null; accessed_at: string; evidence: Record<string, unknown> };
type Lead = { id: number; company: string; city: string; country: string; products: string[]; email: string; phone: string; website: string; source_type: string; status: string; discovered_at: string; duplicate_matches: Match[]; sources?: Source[]; history?: { id: number; action: string; detail: string; at: string }[]; research?: { id: number; url: string; status: string; accessed_at: string }[] };
type Job = { id: number; trigger_type: string; status: string; stage: string; created_at: string; found: number; duplicates: number; failed: number; skipped: number; error: string | null; search_results?: { id: number; provider: string; query: string; url: string; title: string; disposition: string }[]; attempts?: { id: number; url: string; status: string; detail: string; accessed_at: string }[] };
type Schedule = { enabled: boolean; interval_seconds: number; filters: { product: string; city: string; keywords: string; mode?: "automatic" | "seeds" | null; rotation_enabled?: boolean }; rotation_enabled: boolean; next_criteria: { product: string; city: string; keywords: string }; status: string; blocked_reason: string | null; next_run_at: string | null; last_error: string | null; last_job: { id: number; status: string } | null };
type Summary = { agent_status: "Running" | "Ready" | "Paused" | "Error"; total: number; web_discoveries: number; website_submissions: number; pending_review: number; duplicates: number; completed_jobs: number; failed_jobs: number; last_research: string | null; search_usage: { used: number; limit: number; reserved: number; cache_seconds: number; paused_reason: string | null; cycle_renewal: string | null; account: { account_status: string; searches_per_month: number; plan_renewal_date: string | null; plan_searches_left: number; total_searches_left: number; checked_at: string } | null }; active: boolean; latest_job: Job | null; schedule: Schedule; provider_check: { status: string; checked_at: string | null; error: string | null; result_count?: number }; configuration: { seed_urls: string[]; allowed_domains: string[]; search_provider: string; search_configured: boolean; schedule_seconds: number; automatic_ready: boolean; source_policy: string; setup_errors: string[] } };

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/console/discovery/${path}`, { cache: "no-store", signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  } catch { throw new ApiError("Cannot reach Supplier Discovery. Check that Next.js is running on port 3000 and FastAPI on port 8000, then Retry.", 503); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(typeof data?.detail === "string" ? data.detail : `Supplier Discovery request failed (HTTP ${response.status}). Check the service and research inputs, then Retry.`, response.status);
  if (!data) throw new ApiError("Supplier Discovery returned an invalid response. Restart the backend and Retry.", 503);
  return data;
}
function Reference({ url, children }: { url: string; children?: React.ReactNode }) {
  return /^https?:\/\//i.test(url) ? <a className="break-all text-accent underline" href={url} target="_blank" rel="noopener noreferrer">{children ?? url}</a> : <span>{children ?? (url || "Not provided")}</span>;
}
const timestamp = (value: string | null) => value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Karachi" }) + " PKT" : "No research yet";

function SourceEvidence({ source }: { source: Source }) {
  const evidence = source.evidence;
  const fields = typeof evidence.fields === "object" && evidence.fields ? evidence.fields as Record<string, unknown> : evidence;
  const snippets = Array.isArray(evidence.snippets) ? evidence.snippets as { field_value: string; quote: string }[] : [];
  const labels: Record<string, string> = { company: "Company", city: "City", country: "Country", products: "Products", product: "Product", email: "Business email", phone: "Phone", quantity: "Quantity / capacity", message: "Submitted message" };
  return <div className="mt-3 text-sm">
    <dl className="grid gap-2 sm:grid-cols-2">{Object.entries(labels).map(([key, label]) => fields[key] ? <div key={key} className={key === "message" ? "sm:col-span-2" : ""}><dt className="text-xs text-stone">{label}</dt><dd className="break-words">{Array.isArray(fields[key]) ? (fields[key] as string[]).join(", ") : String(fields[key])}</dd></div> : null)}</dl>
    {!!snippets.length && <details className="mt-3" open><summary className="font-medium">Extracted source excerpts</summary><div className="mt-2 max-h-64 space-y-3 overflow-auto">{snippets.map((snippet, index) => <blockquote key={index} className="border-l-2 border-line pl-3 text-xs leading-5"><p className="font-medium">{snippet.field_value}</p><p>{snippet.quote}</p></blockquote>)}</div></details>}
  </div>;
}

export default function SupplierDiscovery() {
  const initialized = useRef(false);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("Suppliers");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [unavailable, setUnavailable] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ q: "", product: "", city: "", status: "" });
  const [research, setResearch] = useState({ product: "", city: "", keywords: "" });
  const [sourceUrl, setSourceUrl] = useState("");
  const [researchMode, setResearchMode] = useState<"automatic" | "manual" | "seeds">("automatic");
  const [scheduleDraft, setScheduleDraft] = useState<Pick<Schedule, "enabled" | "interval_seconds" | "filters">>({ enabled: false, interval_seconds: 3600, filters: { product: "", city: "", keywords: "", mode: "seeds" as "automatic" | "seeds" | null | undefined } });
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [permission, setPermission] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  useEffect(() => { if (detail && !detailDialog.current?.open) detailDialog.current?.showModal(); }, [detail]);

  const refresh = useCallback(async () => {
    try {
      const query = new URLSearchParams({ ...filters, page: String(page) });
      const [s, l, j] = await Promise.all([api<Summary>("summary"), api<{ items: Lead[]; total: number }>(`leads?${query}`), api<{ items: Job[] }>("jobs")]);
      if (!s.schedule || !s.provider_check || !s.search_usage || !Array.isArray(s.configuration?.setup_errors)) throw new ApiError("The discovery backend is outdated. Restart backend/.venv/Scripts/python.exe backend/run.py to load automatic search and scheduling.", 503);
      if (!initialized.current) {
        initialized.current = true;
        setResearch({ product: s.schedule.filters.product || "", city: s.schedule.filters.city || "", keywords: s.schedule.filters.keywords || "" });
        setResearchMode(s.configuration.automatic_ready ? "automatic" : "seeds");
      }
      setSummary(s); setLeads(l.items); setTotal(l.total); setJobs(j.items); setLoadError(""); setUnavailable(false);
      setJob((current) => current ? { ...current, ...(j.items.find((entry) => entry.id === current.id) ?? {}) } : current);
    } catch (err) { setLoadError(err instanceof Error ? err.message : "Unable to load discovery"); setUnavailable(!(err instanceof ApiError) || err.status >= 500); }
    finally { setLoading(false); }
  }, [filters, page]);
  useEffect(() => { void refresh(); const interval = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(interval); }, [refresh]);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Action failed"); }
    finally { setBusy(false); }
  }
  async function review(action: string, match?: Match) {
    if (!detail) return;
    await perform(async () => {
      await api(`leads/${detail.id}/review`, { action, note: reviewNote, ...(match ? { [match.kind === "vendor" ? "linked_vendor_id" : "linked_lead_id"]: match.id } : {}) });
      setDetail(await api<Lead>(`leads/${detail.id}`)); setNotice("Review saved. Supplier verification remains separate.");
    });
  }

  const validUrl = (() => { try { const url = new URL(sourceUrl.trim()); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } })();
  const hasCriteria = Object.values(research).some((value) => value.trim());
  const sourceReady = researchMode === "automatic" ? !!summary?.configuration.automatic_ready : researchMode === "manual" ? validUrl && permission : !!summary?.configuration.seed_urls.length;
  const canRun = !!summary && !loadError && !busy && !summary.active && (hasCriteria || researchMode !== "automatic") && sourceReady;
  const disabledReason = busy ? "Another action is in progress." : summary?.active ? "A research job is already running." : !summary || loadError ? "Connect to the discovery backend first." : researchMode === "automatic" && !summary.configuration.automatic_ready ? "Search provider not configured. Add backend credentials, or select Manual website." : researchMode === "manual" && !validUrl ? "Enter a valid public HTTP(S) supplier website." : researchMode === "manual" && !permission ? "Confirm permission to research the website." : researchMode === "seeds" && !summary.configuration.seed_urls.length ? "No permitted seed URLs are configured." : !hasCriteria && researchMode === "automatic" ? "Enter a product, city or keywords." : "";
  const displayedSchedule = scheduleDirty ? scheduleDraft : summary?.schedule ?? scheduleDraft;
  const agentStatus = error || loadError || unavailable ? "Error" : summary?.agent_status ?? "Paused";
  async function retry() { setLoading(true); setError(""); await refresh(); }

  return <Panel className="mb-8 p-4 sm:p-6"><article data-testid="agent-dashboard" data-agent-id="supplier-discovery">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="mb-2 text-xs text-stone">Supplier agent 01</p><h1 className="text-[2rem] leading-tight">Supplier Discovery</h1><p className="mt-2 text-sm text-stone">Find suppliers. Review the evidence. Build your pipeline.</p></div><Pill tone={agentStatus === "Ready" ? "good" : agentStatus === "Running" || agentStatus === "Paused" ? "warn" : "bad"}>{agentStatus}</Pill></div>
    <div className="mt-5 flex flex-wrap items-center gap-3"><button className="btn btn-accent disabled:opacity-50" disabled={!canRun} title={disabledReason} onClick={() => void perform(async () => {
      const result = await api<{ id: number }>("jobs", { ...research, mode: researchMode, seed_urls: researchMode === "manual" && sourceUrl.trim() ? [sourceUrl.trim()] : [], source_permission_confirmed: researchMode === "manual" && permission });
      setNotice(`Research job #${result.id} started.`);
    })}>Run Now</button><button className="btn btn-line" aria-expanded={settingsOpen} aria-controls="discovery-settings" onClick={() => setSettingsOpen(!settingsOpen)}>Settings</button><button className="btn btn-line disabled:opacity-50" disabled={busy || !summary?.schedule.enabled} onClick={() => void perform(async () => { await api("schedule/pause", {}); setNotice("Schedule paused. No future runs will start. Use Cancel Job to stop current research."); })}>Pause Automation</button><button className="btn btn-line disabled:opacity-50" disabled={busy || !summary || summary.schedule.enabled || !summary.configuration.automatic_ready} onClick={() => void perform(async () => { await api("schedule/resume", {}); setNotice("Automation resumed. The next rotating research run is in 48 hours; no search was triggered now."); })}>Resume Automation</button>{summary?.active && summary.latest_job && <button className="btn btn-line disabled:opacity-50" disabled={busy} onClick={() => void perform(async () => { await api(`jobs/${summary.latest_job!.id}/cancel`, {}); setNotice("Job cancelled. Saved evidence remains available; no automatic retry."); })}>Cancel Job</button>}{disabledReason && !summary?.active && <span className="text-xs text-stone">{disabledReason} Open Settings to configure research.</span>}</div>
    {loading && <p role="status" className="mt-4">Loading discovery records…</p>}
    {(error || loadError) && <div role="alert" className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm">{error || loadError}<button disabled={loading} onClick={() => void retry()} className="ml-3 underline">Retry</button></div>}
    {notice && <p role="status" className="mt-3 text-sm text-green-800">{notice}</p>}
    {summary && !summary.configuration.automatic_ready && <p className="mt-4 text-xs text-stone">Search provider not configured. Permitted seed research and manual websites remain available.</p>}
    {summary && <>
      <p className="mt-4 text-xs text-stone">Search requests this billing cycle: {summary.search_usage.used} / {summary.search_usage.limit} local budget. {summary.search_usage.reserved} account searches reserved for you. Repeated queries use cached results.</p>
      {summary.search_usage.paused_reason && <p role="status" className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm">{summary.search_usage.paused_reason}</p>}
      <dl className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">{[["Last successful research", timestamp(summary.last_research)], ["Next automatic research", summary.schedule.enabled && !summary.schedule.blocked_reason ? timestamp(summary.schedule.next_run_at) : summary.schedule.blocked_reason ? "Paused" : "Not scheduled"], ["SerpApi searches left", summary.search_usage.account ? Math.min(summary.search_usage.account.plan_searches_left, summary.search_usage.account.total_searches_left) : "Check account"], ["New suppliers", summary.web_discoveries], ["Pending reviews", summary.pending_review]].map(([label, value]) => <div key={label} className="rounded-lg border border-line bg-bone/50 p-4"><dt className="text-xs text-stone">{label}</dt><dd className="mt-2 break-words text-base font-medium tabular-nums">{value}</dd></div>)}</dl>
    </>}
    <section id="discovery-settings" aria-label="Discovery settings" hidden={!settingsOpen} className="mt-5 rounded-lg border border-line bg-bone/30 p-4">
    <h2 className="font-semibold">Research settings</h2>
    {summary && <>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section aria-label="DuckDuckGo search" className="rounded border border-line p-4 text-sm">
          <h4 className="font-semibold">DuckDuckGo search</h4>
          <p className="mt-2">{"DuckDuckGo organic results via SerpApi"} &middot; {summary.configuration.automatic_ready ? "Credentials configured" : "Search provider not configured"}</p>
          <p className="mt-2 text-xs text-stone">Scheduled seed research and manual website research remain available without a search key. Add SERPAPI_API_KEY to backend/.env locally; a new key is detected automatically. Never enter it in this dashboard.</p>
          <p className="mt-2 text-xs">Source policy: {summary.configuration.source_policy === "public" ? "Public search results, subject to robots and access restrictions" : "Configured permitted domains only"}. {summary.configuration.allowed_domains.length} listed domains; {summary.configuration.seed_urls.length} permitted seeds.</p>
          {summary.configuration.setup_errors.map((message) => <p key={message} className="mt-2 text-xs text-stone">{message}</p>)}
          <p className="mt-2 text-xs">Last account check: {summary.search_usage.account?.checked_at ? timestamp(summary.search_usage.account.checked_at) : "Not checked"}</p>
          {summary.search_usage.account && <p className="mt-2 text-xs">Remaining SerpApi allowance: {Math.min(summary.search_usage.account.plan_searches_left, summary.search_usage.account.total_searches_left)} searches at the last free account check. No search credits are used to check the account.</p>}
          {summary.search_usage.account && <dl className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-stone">Subscription</dt><dd className="mt-1">{summary.search_usage.account.account_status}</dd></div><div><dt className="text-stone">Monthly allowance</dt><dd className="mt-1">{summary.search_usage.account.searches_per_month}</dd></div><div><dt className="text-stone">Provider renewal date</dt><dd className="mt-1">{summary.search_usage.account.plan_renewal_date || "Not supplied by provider"}</dd></div><div><dt className="text-stone">Local budget renewal</dt><dd className="mt-1">Only after provider confirmation</dd></div></dl>}
          {summary.provider_check.error && <p className="mt-2 text-xs text-red-800">{summary.provider_check.error}</p>}
          <button type="button" disabled={busy || !summary.configuration.search_configured} className="btn btn-line mt-3 disabled:opacity-50" onClick={() => void perform(async () => { await api("provider/check", research); setNotice("SerpApi account checked. No search credits used. Run Now searches DuckDuckGo organic results."); })}>Check account (free)</button>
        </section>
        <section aria-label="Recurring discovery" className="rounded border border-line p-4 text-sm">
          <h4 className="font-semibold">Recurring discovery</h4>
          <p className="mt-2">Status: {summary.schedule.status} &middot; Next due: {summary.schedule.next_run_at ? timestamp(summary.schedule.next_run_at) : "Not scheduled"}</p>
          {summary.schedule.blocked_reason && <p className="mt-2 text-xs text-red-800">{summary.schedule.blocked_reason}</p>}
          {summary.schedule.last_error && <p className="mt-2 text-xs text-red-800">Last scheduler error: {summary.schedule.last_error}</p>}
          {summary.schedule.last_job && <p className="mt-2 text-xs">Last scheduled job #{summary.schedule.last_job.id}: {summary.schedule.last_job.status}</p>}
          {summary.schedule.rotation_enabled && <p className="mt-2 text-xs text-stone">Rotates every 48 hours. Next: {summary.schedule.next_criteria.product} &middot; {summary.schedule.next_criteria.city || "Pakistan"} &middot; {summary.schedule.next_criteria.keywords}. Existing suppliers are rechecked after seven days where permitted.</p>}
          <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await api("schedule", { enabled: displayedSchedule.enabled, interval_seconds: displayedSchedule.interval_seconds, filters: displayedSchedule.filters }); setScheduleDirty(false); setNotice("Recurring discovery settings saved."); }); }}>
            <label className="flex items-center gap-2 text-xs sm:col-span-2"><input type="checkbox" checked={!!displayedSchedule.filters.rotation_enabled} onChange={(e) => { setScheduleDraft({ ...displayedSchedule, interval_seconds: e.target.checked ? 172800 : displayedSchedule.interval_seconds, filters: { ...displayedSchedule.filters, mode: e.target.checked ? "automatic" : displayedSchedule.filters.mode, rotation_enabled: e.target.checked } }); setScheduleDirty(true); }} />Rotate cities, categories and keywords every 48 hours</label>
            <label className="text-xs">Scheduled method<select aria-label="Scheduled method" disabled={!!displayedSchedule.filters.rotation_enabled} className="field mt-1" value={displayedSchedule.filters.mode || (summary.configuration.automatic_ready ? "automatic" : "seeds")} onChange={(e) => { setScheduleDraft({ ...displayedSchedule, filters: { ...displayedSchedule.filters, mode: e.target.value as "automatic" | "seeds" } }); setScheduleDirty(true); }}><option value="seeds">Permitted seed websites</option><option value="automatic">DuckDuckGo via SerpApi</option></select></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={displayedSchedule.enabled} onChange={(e) => { setScheduleDraft({ ...displayedSchedule, enabled: e.target.checked }); setScheduleDirty(true); }} />Enable recurring research</label>
            <label className="text-xs">Interval (minutes)<input type="number" min={1} max={43200} disabled={!!displayedSchedule.filters.rotation_enabled} required className="field mt-1" value={displayedSchedule.interval_seconds / 60} onChange={(e) => { setScheduleDraft({ ...displayedSchedule, interval_seconds: Math.max(60, Math.round(Number(e.target.value) * 60)) }); setScheduleDirty(true); }} /></label>
            {(["product", "city", "keywords"] as const).map((field) => <label className="text-xs" key={field}>Scheduled {field}<input className="field mt-1" disabled={!!displayedSchedule.filters.rotation_enabled} value={displayedSchedule.filters[field] ?? ""} onChange={(e) => { setScheduleDraft({ ...displayedSchedule, filters: { ...displayedSchedule.filters, [field]: e.target.value } }); setScheduleDirty(true); }} /></label>)}
            <button disabled={busy || (displayedSchedule.enabled && !(summary.configuration.automatic_ready || summary.configuration.seed_urls.length))} className="btn btn-line self-end disabled:opacity-50">Save schedule</button>
            <p className="text-xs leading-5 text-stone sm:col-span-2">Rotating automation uses a fixed 48-hour interval and its own criteria. Run Now always uses your manual research settings. Only one research job runs at a time; repeated results link existing leads. Enabling requires a configured search provider or permitted backend seeds.</p>
          </form>
        </section>
      </div>
    </>}
    <div className="mt-5 grid gap-3 border-t border-line pt-5 md:grid-cols-3">
      <label className="text-xs md:col-span-3">Research mode<select aria-label="Research mode" className="field mt-1 max-w-sm" value={researchMode} onChange={(e) => setResearchMode(e.target.value as "automatic" | "manual" | "seeds")}><option value="automatic">DuckDuckGo search by product, city and keywords</option><option value="manual">Manual website research</option><option value="seeds">Configured permitted seeds</option></select></label>
      {(["product", "city", "keywords"] as const).map((field) => <label key={field} className="text-xs capitalize">Research {field}<input className="field mt-1" value={research[field]} onChange={(e) => setResearch({ ...research, [field]: e.target.value })} /></label>)}
      <label className="text-xs md:col-span-3">Public supplier website (manual research only)<input type="url" placeholder="https://www.cbi.com.pk/" className="field mt-1" value={sourceUrl} onChange={(e) => { setSourceUrl(e.target.value); setPermission(false); if (e.target.value.trim()) setResearchMode("manual"); }} /></label>
      {researchMode === "manual" && <label className="flex items-start gap-2 text-xs md:col-span-3"><input type="checkbox" checked={permission} onChange={(e) => setPermission(e.target.checked)} />I have permission to research this public website and have checked its terms.</label>}
      <p id="discovery-requirements" className="text-xs leading-5 text-stone md:col-span-3">{disabledReason || (researchMode === "automatic" ? "Ready for automatic search. No supplier URL is needed. Search results are validated and crawled under the configured source policy." : "Ready to research the selected permitted sources.")} City is optional. Discovery never approves a vendor.</p>
    </div>
    </section>
    <div role="tablist" aria-label="Discovery views" className="mt-6 flex gap-5 border-b border-line">{["Suppliers", "History"].map((name) => <button role="tab" key={name} aria-selected={tab === name} aria-controls={`discovery-${name}`} className={`border-b-2 py-3 text-sm ${tab === name ? "border-accent font-semibold text-accent" : "border-transparent text-stone"}`} onClick={() => setTab(name)}>{name}</button>)}</div>
    {summary?.latest_job && <div role="status" className="mt-4 rounded border border-line bg-bone/50 p-3 text-sm">Job #{summary.latest_job.id}: {summary.latest_job.status} &middot; {summary.latest_job.stage}{!["Running", "Queued"].includes(summary.latest_job.status) && <span> &middot; New {summary.latest_job.found} &middot; Duplicates {summary.latest_job.duplicates} &middot; Failed {summary.latest_job.failed} &middot; Skipped {summary.latest_job.skipped}</span>}{summary.latest_job.error && <p className="mt-1 text-red-800">{summary.latest_job.error}</p>}</div>}
    <section id="discovery-Suppliers" hidden={tab !== "Suppliers"}>
    <div className="mt-6 grid gap-3 md:grid-cols-4">{(["q", "city", "product"] as const).map((field) => <label key={field} className="text-xs">{field === "q" ? "Search suppliers" : `Filter ${field}`}<input className="field mt-1" value={filters[field]} onChange={(e) => { setPage(1); setFilters({ ...filters, [field]: e.target.value }); }} /></label>)}<label className="text-xs">Review status<select className="field mt-1" value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }}><option value="">All statuses</option>{["Pending Review", "Reviewed", "Dismissed", "Duplicate"].map((s) => <option key={s}>{s}</option>)}</select></label></div>
    {!loading && !loadError && !leads.length && <p className="my-6 text-sm text-stone">No supplier leads match. Run permitted research or submit the website’s I want to sell form.</p>}
    <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-line">{["Company", "City", "Products", "Source", "Review status"].map((s) => <th className="p-2 font-medium" key={s}>{s}</th>)}</tr></thead><tbody>{leads.map((lead) => <tr className="border-b border-line" key={lead.id}><td className="p-2"><button className="text-left font-medium text-accent underline" onClick={() => void perform(async () => { setDetail(await api<Lead>(`leads/${lead.id}`)); setReviewNote(""); })}>{lead.company}</button></td><td className="p-2">{lead.city || "Not provided"}</td><td className="p-2">{lead.products.join(", ") || "Not provided"}</td><td className="p-2">{lead.source_type}</td><td className="p-2"><Pill>{lead.status}</Pill></td></tr>)}</tbody></table></div>
    {summary && <div className="mt-3 flex items-center gap-3 text-sm"><button disabled={page === 1} onClick={() => setPage(page-1)} className="disabled:opacity-40">Previous</button><span>Page {page} · {total} leads</span><button disabled={page * 20 >= total} onClick={() => setPage(page+1)} className="disabled:opacity-40">Next</button></div>}
    </section>
    {detail && <dialog ref={detailDialog} onCancel={() => setDetail(null)} aria-label="Supplier details" className="fixed inset-y-4 left-auto right-4 m-0 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl border border-line bg-paper p-6 text-ink shadow-2xl backdrop:bg-ink/20"><div className="flex justify-between gap-4"><h4 className="text-lg font-semibold">{detail.company}</h4><button onClick={() => setDetail(null)}>Close details</button></div><p className="mt-2 text-sm">{detail.city || "City not provided"} · {detail.country || "Country not provided"} · {detail.products.join(", ")}</p><p className="mt-2 text-sm">Business email: {detail.email || "Not provided"} · Phone: {detail.phone || "Not provided"}</p><Reference url={detail.website} />
      <h5 className="mt-4 font-medium">Sources and evidence</h5>{detail.sources?.map((source) => <div key={source.id} className="mt-2 rounded border border-line bg-paper p-3 text-sm"><p>{source.source_type} · Accessed {timestamp(source.accessed_at)}</p>{source.url && <Reference url={source.url} />}{source.enquiry_id && <p>Original seller form: <a href="/console/enquiries" className="text-accent underline">{source.enquiry_id}</a></p>}<SourceEvidence source={source} />{Array.isArray(source.evidence.attachments) && <ul>{source.evidence.attachments.map((file) => typeof file === "string" && <li key={file}><a className="text-accent underline" href={`/api/console/files/${file.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noopener noreferrer">Attachment: {file.split("/").pop()}</a></li>)}</ul>}</div>)}
      <h5 className="mt-4 font-medium">Duplicate matches</h5>{!detail.duplicate_matches.length && <p className="text-sm text-stone">No matching leads or vendors detected.</p>}{detail.duplicate_matches.map((match) => <div key={`${match.kind}-${match.id}`} className="mt-2 flex flex-wrap items-center gap-3 text-sm"><span>{match.kind} #{match.id}: {match.name} ({match.reasons.join(", ")})</span><button disabled={busy} className="underline" onClick={() => void review(match.kind === "vendor" ? "review" : "duplicate", match)}>{match.kind === "vendor" ? "Link supplier for qualification" : "Link duplicate"}</button></div>)}
      <label className="mt-4 block text-xs">Review note<textarea className="field mt-1" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} /></label><div className="mt-3 flex flex-wrap gap-3">{[["review", "Approve for qualification"], ["dismiss", "Dismiss lead"], ["reopen", "Return to pending"]].map(([action, label]) => <button key={action} disabled={busy} className="btn btn-line" onClick={() => void review(action)}>{label}</button>)}</div>
      <h5 className="mt-4 font-medium">Research and review history</h5><ul className="mt-2 space-y-2 text-xs">{detail.history?.map((entry) => <li key={entry.id}>{timestamp(entry.at)} · {entry.action} · {entry.detail}</li>)}{detail.research?.map((entry) => <li key={`r${entry.id}`}>{timestamp(entry.accessed_at)} · {entry.status} · <Reference url={entry.url} /></li>)}</ul>
    </dialog>}
    <section id="discovery-History" hidden={tab !== "History"}><h4 className="mt-6 font-semibold">Research job history</h4>{!jobs.length && <p className="mt-2 text-sm text-stone">No research jobs yet.</p>}<ul className="mt-2 space-y-2 text-sm">{jobs.map((entry) => <li key={entry.id} className="rounded border border-line p-3"><button className="text-accent underline" onClick={() => void perform(async () => setJob(await api<Job>(`jobs/${entry.id}`)))}>View job #{entry.id}</button> &middot; {entry.trigger_type === "Scheduled" ? "Automatic" : "Manual"} &middot; {entry.status} · {entry.stage}<p className="mt-1 text-xs text-stone">{timestamp(entry.created_at)} · New {entry.found} · Duplicates {entry.duplicates} · Failed {entry.failed} · Skipped {entry.skipped}</p>{entry.error && <p className="text-red-800">{entry.error}</p>}</li>)}</ul>
    {job && <section className="mt-3 rounded border border-line p-3 text-sm" aria-label="Research job details"><h5 className="font-medium">Job #{job.id} &middot; {job.trigger_type === "Scheduled" ? "Automatic" : "Manual"} &middot; {job.status}</h5><button className="underline" onClick={() => setJob(null)}>Close job</button>{job.error && <p>{job.error}</p>}{!!job.search_results?.length && <details className="mt-3" open><summary>Search results ({job.search_results.length})</summary>{job.search_results.map((result) => <div key={result.id} className="mt-3 text-xs"><p>{result.provider}: {result.query}</p><Reference url={result.url}>{result.title || result.url}</Reference><p>{result.disposition}</p></div>)}</details>}{job.attempts?.map((a) => <div className="mt-3" key={a.id}><p>{a.status} · {timestamp(a.accessed_at)}</p><Reference url={a.url} /><p>{a.detail}</p></div>)}</section>}
    </section>
  </article></Panel>;
}
