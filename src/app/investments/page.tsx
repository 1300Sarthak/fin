import Link from "next/link";
import { Landmark } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { InvestmentsWorkspaceView } from "@/components/finance-workspaces";
import { getInvestmentsWorkspace } from "@/lib/workspaces";
import { getAccountsList } from "@/lib/queries";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Portfolio balances, composition, recorded value history, and account activity — separate from day-to-day spending.";

export default async function InvestmentsPage() {
  const [data, accounts] = await Promise.all([getInvestmentsWorkspace(), getAccountsList()]);
  if (data.accounts.length === 0) {
    return <><PageHeader title="Investments" description={DESCRIPTION} />
      {accounts.length === 0
        ? <EmptyState icon={Landmark} title="No investments to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
        : <EmptyState icon={Landmark} title="No investment accounts yet" description="None of your connected accounts is a brokerage, IRA, or crypto account. Sync a provider that holds one, or check that it is still marked active." action={<Link href="/accounts" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Review accounts</Link>} />}
    </>;
  }
  return <><PageHeader title="Investments" description={DESCRIPTION} /><InvestmentsWorkspaceView data={data} /></>;
}
