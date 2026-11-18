import { requireUser } from "@/lib/trade/auth";
import { PageHead } from "@/components/console/ui";
import AgentOverview from "@/components/console/AgentOverview";

export const metadata = { title: "AI Control Center" };

export default async function AgentControlCenter() {
  await requireUser("admin");
  return <><PageHead title="AI Control Center" sub="Manage and oversee the intelligent workflows powering Cardboard Package, bringing supplier operations, inventory intelligence and business automation together in one place." /><AgentOverview /></>;
}
