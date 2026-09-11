import Link from "next/link";
import { Landmark } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { HoldingsView } from "@/components/holdings-view";
import { getHoldings, getPortfolioSummary } from "@/lib/holdings";
import { getAccountsList } from "@/lib/queries";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Every position across your investment accounts, with cost basis and how much is sitting in cash.";

export default async function HoldingsPage() {
  const [rows, summary, accounts] = await Promise.all([getHoldings(), getPortfolioSummary(), getAccountsList()]);
  if (rows.length === 0) {
    return (
      <>
        <PageHeader title="Holdings" description={DESCRIPTION} />
        {accounts.length === 0 ? (
          <EmptyState icon={Landmark} title="No positions to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
        ) : (
          <EmptyState
            icon={Landmark}
            title="No positions recorded"
            description="Holdings arrive with the account data. Run a sync — providers that only report a balance will never fill this page."
            action={<Link href="/investments" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>See investment balances</Link>}
          />
        )}
      </>
    );
  }
  return (
    <>
      <PageHeader title="Holdings" description={DESCRIPTION} />
      <HoldingsView rows={rows} summary={summary} />
    </>
  );
}
