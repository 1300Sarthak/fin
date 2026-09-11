import Link from "next/link";
import { addMonths, format, subMonths } from "date-fns";
import { ChevronLeft, ChevronRight, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { EarningsWorkspaceView } from "@/components/finance-workspaces";
import { getEarningsWorkspace } from "@/lib/workspaces";
import { getAccountsList } from "@/lib/queries";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Cash earnings and retirement deposits, shown separately so transfers never inflate income.";

export default async function EarningsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams;
  const [data, accounts] = await Promise.all([getEarningsWorkspace(month), getAccountsList()]);
  if (accounts.length === 0) {
    return <><PageHeader title="Earnings" description={DESCRIPTION} />
      <EmptyState icon={TrendingUp} title="No earnings to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
    </>;
  }
  const current = new Date(`${data.monthKey}-01T12:00:00`);
  const previous = format(subMonths(current, 1), "yyyy-MM");
  const next = format(addMonths(current, 1), "yyyy-MM");
  return <><PageHeader title="Earnings" description={DESCRIPTION} />
    <div className="mb-4 flex items-center gap-2">
      <Link href={`/earnings?month=${previous}`} className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-8")} aria-label="Previous month"><ChevronLeft className="size-4" /></Link>
      <span className="min-w-40 text-center text-sm font-medium">{data.monthLabel}</span>
      <Link href={`/earnings?month=${next}`} className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-8")} aria-label="Next month"><ChevronRight className="size-4" /></Link>
    </div>
    <EarningsWorkspaceView data={data} />
  </>;
}
