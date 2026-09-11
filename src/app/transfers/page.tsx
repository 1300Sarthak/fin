import Link from "next/link";
import { CircleDollarSign } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { TransfersWorkspaceView } from "@/components/finance-workspaces";
import { getTransfersWorkspace } from "@/lib/workspaces";
import { getAccountsList } from "@/lib/queries";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Money moved between your own accounts. It stays visible here but never counts as income or spending.";

export default async function TransfersPage() {
  const [data, accounts] = await Promise.all([getTransfersWorkspace(), getAccountsList()]);
  if (data.transfers.length === 0) {
    return <><PageHeader title="Transfers" description={DESCRIPTION} />
      {accounts.length === 0
        ? <EmptyState icon={CircleDollarSign} title="No transfers to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
        : <EmptyState icon={CircleDollarSign} title="No internal transfers found" description="Nothing has been classified as a move between your own accounts. Open a transaction and mark it as a transfer to keep it out of income and spending." action={<Link href="/transactions" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Browse transactions</Link>} />}
    </>;
  }
  return <><PageHeader title="Transfers" description={DESCRIPTION} /><TransfersWorkspaceView data={data} /></>;
}
