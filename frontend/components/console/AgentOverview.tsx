"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Boxes, Search, Users, Settings2 } from "lucide-react";
import { AGENT_DEMOS } from "@/lib/trade/agents";
import { Pill } from "./ui";

const groups = [{ name: "Supplier", group: "Supplier agents", count: 4 }, { name: "Buyer", group: "Buyer agents", count: 4 }, { name: "Operations", group: "Shared operations", count: 2 }];
export default function AgentOverview() {
  const [tab, setTab] = useState("Supplier");
  const [status, setStatus] = useState("Paused");
  const [message, setMessage] = useState("Connecting to Supplier Discovery…");
  const [implemented, setImplemented] = useState<Record<string, { label: string; detail: string; available: boolean }>>({});
  useEffect(() => {
    let active = true;
    async function check(id: string, route: string) {
      try {
        const response = await fetch(`/api/console/${route}/summary`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
        const data = await response.json();
        if (!response.ok || (route === "catalog" ? typeof data.imports !== "number" : typeof data.counts?.monitored_suppliers !== "number")) throw new Error("Backend unavailable");
        const localEmail = route === "stock" && data.email?.mode === "mock";
        if (active) setImplemented(previous => ({ ...previous, [id]: { available: true,
          label: localEmail ? "Local email mode" : "Development ready",
          detail: route === "catalog" ? `${data.awaiting_review} products awaiting Admin review` : localEmail ? "Implemented · real email delivery disabled" : "Implemented · production activation requires separate verification" } }));
      } catch {
        if (active) setImplemented(previous => ({ ...previous, [id]: { available: false, label: "Backend unavailable", detail: "Implemented interface · open for connection details" } }));
      }
    }
    void Promise.all([check("supplier-catalog", "catalog"), check("supplier-stock", "stock")]);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch("/api/console/discovery/summary", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Discovery is offline. Open the agent to retry.");
        if (active) {
          setStatus(data.agent_status);
          setMessage(data.active ? "Researching permitted sources" : `${data.pending_review} suppliers pending review`);
        }
      } catch (error) { if (active) { setStatus("Error"); setMessage(error instanceof Error ? error.message : "Discovery is offline"); } }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const selected = groups.find((group) => group.name === tab)!;
  return <>
    <div role="tablist" aria-label="Agent groups" className="mb-6 flex gap-1 border-b border-line">{groups.map((group) => <button key={group.name} role="tab" id={`tab-${group.name}`} aria-controls="agent-cards" aria-selected={tab === group.name} onClick={() => setTab(group.name)} className={`border-b-2 px-3 py-3 text-sm transition-colors sm:px-5 ${tab === group.name ? "border-accent font-semibold text-accent" : "border-transparent text-stone hover:text-ink"}`}>{group.name} ({group.count})</button>)}</div>
    <section role="tabpanel" id="agent-cards" aria-labelledby={`tab-${tab}`} className="grid gap-4 md:grid-cols-2">
      {AGENT_DEMOS.filter((agent) => agent.group === selected.group).map((agent) => {
        const discovery = agent.id === "supplier-discovery";
        const qualification = agent.id === "supplier-qualification";
        const catalog = agent.id === "supplier-catalog";
        const stock = agent.id === "supplier-stock";
        const runtime = implemented[agent.id];
        const Icon = discovery ? Search : tab === "Supplier" ? Boxes : tab === "Buyer" ? Users : Settings2;
        return <Link data-testid="agent-card" data-agent-id={agent.id} key={agent.id} href={`/console/admin/agents/${agent.id}`} className="group rounded-xl border border-line bg-paper p-5 transition hover:border-accent/50 hover:shadow-sm sm:p-6">
          <div className="flex items-center justify-between"><span className="rounded-lg bg-bone p-2.5 text-accent"><Icon size={21} strokeWidth={1.6} /></span><Pill tone={discovery ? status === "Error" ? "bad" : status === "Running" ? "warn" : status === "Ready" ? "good" : "info" : catalog || stock ? runtime?.available === false ? "warn" : "info" : qualification ? "info" : "muted"}>{discovery ? status : catalog || stock ? runtime?.label ?? "Checking backend" : qualification ? "Live" : "Demo"}</Pill></div>
          <h2 className="mt-5 text-lg font-semibold">{agent.name}</h2><p className="mt-2 text-sm leading-6 text-stone">{agent.purpose}</p>
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4 text-xs text-stone"><span className="line-clamp-2">{discovery ? message : catalog || stock ? runtime?.detail ?? "Checking the shared development backend" : qualification ? "Supplier verification and market prices" : "Preview dashboard"}</span><ArrowUpRight className="shrink-0 text-accent transition group-hover:translate-x-0.5" size={18} /></div>
        </Link>;
      })}
    </section>
    <p className="mt-6 text-xs text-stone">Supplier discoveries go to Pending Review. Approval always stays with your team.</p>
  </>;
}
