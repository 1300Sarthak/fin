import { FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TaxWorkspace } from "./tax-workspace";
import { getFinancialPlanningContext } from "@/lib/financial-planning";

export const dynamic = "force-dynamic";

export default async function TaxesPage() {
  const context = await getFinancialPlanningContext();
  return (
    <>
      <PageHeader title="Taxes & write-offs" description="A 2026 federal illustration from your inputs, and the deductions and credits worth checking." />
      {context.profile ? (
        <TaxWorkspace initialProfile={context.profile} />
      ) : (
        <EmptyState icon={FileCheck2} title="Your saved plan could not be read" description="The stored planning profile is missing or malformed. Saving the form again from the CLI, or resetting it in Settings, restores this page." />
      )}
    </>
  );
}
