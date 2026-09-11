import { PageHeader } from "@/components/page-header";
import { FuturePlanWorkspace } from "@/components/future-plan-workspace";
import { getConfig } from "@/lib/config";
import { DEFAULT_FUTURE_PLAN, type FuturePlanInputs } from "@/lib/future-plan-core";

export const dynamic = "force-dynamic";

export default async function FuturePlanPage() {
  let plan = DEFAULT_FUTURE_PLAN;
  try {
    const saved = await getConfig("future_plan");
    if (saved) plan = { ...DEFAULT_FUTURE_PLAN, ...(JSON.parse(saved) as Partial<FuturePlanInputs>) };
  } catch { /* malformed older preference: fall back safely */ }
  return <><PageHeader title="Future plan" description="Model your next milestones without changing your real financial records." /><FuturePlanWorkspace initialPlan={plan} /></>;
}
