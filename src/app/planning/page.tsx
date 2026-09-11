import { ClipboardList } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PlanningWorkspace } from "@/components/planning-workspace";
import { getFinancialPlanningContext } from "@/lib/financial-planning";

export const dynamic = "force-dynamic";

export default async function PlanningPage() {
  const context = await getFinancialPlanningContext();
  return (
    <>
      <PageHeader title="Financial planning" description="Give every dollar a job, connect your tax picture, and make a plan your agents can work with." />
      {context.profile ? (
        <PlanningWorkspace initialProfile={context.profile} liquidAssetsCents={context.liquid.liquidAssetsCents} uploadCount={context.uploads.length} />
      ) : (
        <EmptyState icon={ClipboardList} title="Your saved plan could not be read" description="The stored planning profile is missing or malformed. Saving the form again from the CLI, or resetting it in Settings, restores this page." />
      )}
    </>
  );
}
