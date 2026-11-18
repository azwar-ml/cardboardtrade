import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/trade/auth";
import { AGENT_DEMOS } from "@/lib/trade/agents";
import { Panel, PageHead, Pill } from "@/components/console/ui";
import SupplierDiscovery from "@/components/console/SupplierDiscovery";
import SupplierQualification from "@/components/console/SupplierQualification";
import SupplierStockMonitor from "@/components/console/SupplierStockMonitor";
import SupplierCatalogIntake from "@/components/console/SupplierCatalogIntake";

export default async function AgentDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireUser("admin");
  const { id } = await params;
  const agent = AGENT_DEMOS.find((entry) => entry.id === id);
  if (!agent) notFound();
  return <><Link className="mb-5 inline-flex text-sm text-stone hover:text-accent" href="/console/admin/agents">← All agents</Link>
    {id === "supplier-discovery" ? <SupplierDiscovery /> : id === "supplier-qualification" ? <SupplierQualification /> : id === "supplier-catalog" ? <SupplierCatalogIntake /> : id === "supplier-stock" ? <SupplierStockMonitor /> : <><PageHead title={agent.name} sub={agent.purpose}><Pill tone="muted">Demo</Pill></PageHead>
      <Panel className="p-6"><article data-testid="agent-dashboard" data-agent-id={id}><h2 className="text-lg font-semibold">Dashboard preview</h2><p className="mt-2 text-sm text-stone">Sample data for this planned agent. No automated work is running.</p>
        <dl className="mt-6 grid gap-4 sm:grid-cols-3">{agent.metrics.map((metric) => <div key={metric.label} className="rounded-lg bg-bone p-5"><dt className="text-sm text-stone">{metric.label}</dt><dd className="mt-3 text-2xl font-semibold">{metric.value}</dd></div>)}</dl>
      </article></Panel></>}
  </>;
}
