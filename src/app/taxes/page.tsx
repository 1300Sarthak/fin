import { FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { PlanningWorkspace } from "@/components/planning-workspace";
import { getFinancialPlanningContext } from "@/lib/financial-planning";

export const dynamic = "force-dynamic";

export default async function TaxesPage() {
  const context = await getFinancialPlanningContext();
  return (
    <>
      <PageHeader title="Taxes & write-offs" description="Organize your 2026 tax inputs and discover which deductions and credits deserve a closer look." />
      {context.profile ? (
        <PlanningWorkspace initialProfile={context.profile} liquidAssetsCents={context.liquid.liquidAssetsCents} uploadCount={context.uploads.length} mode="tax" />
      ) : (
        <EmptyState icon={FileCheck2} title="Your saved plan could not be read" description="The stored planning profile is missing or malformed. Saving the form again from the CLI, or resetting it in Settings, restores this page." />
      )}
    </>
  );
}
