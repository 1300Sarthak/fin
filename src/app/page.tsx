import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { StatCard } from "@/components/stat-card";
import { Delta } from "@/components/delta";
import { NetWorthChart } from "@/components/net-worth-chart";
import { AccountIcon } from "@/components/account-icon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { RangeSelector } from "@/components/range-selector";
import { AccountMultiselect } from "@/components/account-multiselect";
import { LayoutDashboard, CircleAlert, ArrowRight, CheckCircle2 } from "lucide-react";
import {
  getNetWorthSummary,
  parseRange,
  resolveInclusion,
  NET_WORTH_RANGES,
} from "@/lib/networth";
import {
  getAccountsWithInstitution,
  countUncategorized,
  getAccountsList,
} from "@/lib/queries";
import { countRecurringFlags } from "@/lib/recurring";
import { ACCOUNT_TYPE_META } from "@/lib/accounts";
import { formatUSD, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getPeriodHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

const RANGE_OPTIONS = NET_WORTH_RANGES.map((r) => ({
  value: r,
  label: r === "MAX" ? "Max" : r,
}));

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; accounts?: string }>;
}) {
  const { range: rangeParam, accounts: accParam } = await searchParams;
  const range = parseRange(rangeParam);
  const { includeIds, allActiveIds } = await resolveInclusion(accParam);

  const [nw, accs, uncategorized, recurringFlags, accountList, historyRows] = await Promise.all([
    getNetWorthSummary({ range, includeIds, allActiveIds }),
    getAccountsWithInstitution(),
    countUncategorized(),
    countRecurringFlags(),
    getAccountsList(),
    getPeriodHistory("month"),
  ]);

  if (accs.length === 0) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Your complete financial picture across every account."
        />
        <EmptyState
          icon={LayoutDashboard}
          title="Let's get your money on screen"
          description={NO_DATA_DESCRIPTION}
          action={<ConnectDataActions />}
        />
      </>
    );
  }

  const institutions = new Set(accs.map((a) => a.institutionId)).size;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your complete financial picture across every account."
      >
        <AccountMultiselect accounts={accountList} included={[...includeIds]} />
      </PageHeader>

      <Card className="mb-6">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardDescription>Net worth</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {formatUSD(nw.net)}
              </CardTitle>
              <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                <Delta cents={nw.deltaRange} label={range === "MAX" ? "all time" : range} />
                <Delta cents={nw.deltaDay} label="today" />
                <Delta cents={nw.deltaWeek} label="7d" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground text-xs">Made</span>
                  <span className="font-medium text-positive tabular-nums">
                    {formatUSD(nw.rangeIncomeCents)}
                  </span>
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground text-xs">Retirement deposited</span>
                  <span className="font-medium text-info tabular-nums">
                    {formatUSD(nw.rangeRetirementContributionCents)}
                  </span>
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground text-xs">Earned / invested</span>
                  <span className="font-medium text-positive tabular-nums">
                    {formatUSD(nw.rangeEarnedAndInvestedCents)}
                  </span>
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-muted-foreground text-xs">Spent</span>
                  <span className="font-medium text-negative tabular-nums">
                    {formatUSD(nw.rangeSpendingCents)}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  over {range === "MAX" ? "all time" : range}
                </span>
              </div>
            </div>
            <RangeSelector options={RANGE_OPTIONS} value={range} defaultValue="1M" />
          </div>
        </CardHeader>
        <CardContent>
          <NetWorthChart data={nw.series} realFrom={nw.realFrom} />
          {nw.clamped ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Only about {nw.series.length} days of history so far — longer ranges fill in as you keep
              syncing.
            </p>
          ) : nw.partial ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Shaded history before {formatDate(nw.realFrom ?? nw.startDate)} is estimated from
              transactions — it fills in as daily snapshots accumulate.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Liquid money today</CardTitle>
          <CardDescription>Spendable account balances, excluding brokerage, IRA, and crypto. Credit limits are not cash.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div><div className="text-muted-foreground text-xs">Liquid assets</div><div className="mt-1 text-xl font-semibold tabular-nums">{formatUSD(nw.liquidMoney.liquidAssetsCents)}</div><div className="text-muted-foreground mt-1 text-xs">Available balance when supplied</div></div>
          <div><div className="text-muted-foreground text-xs">Liabilities</div><div className="mt-1 text-xl font-semibold text-negative tabular-nums">{formatUSD(nw.liquidMoney.liabilitiesCents)}</div><div className="text-muted-foreground mt-1 text-xs">Balances owed, not credit limits</div></div>
          <div><div className="text-muted-foreground text-xs">Liquid after liabilities</div><div className={cn("mt-1 text-xl font-semibold tabular-nums", nw.liquidMoney.liquidAfterLiabilitiesCents < 0 ? "text-negative" : "text-positive")}>{formatUSD(nw.liquidMoney.liquidAfterLiabilitiesCents)}</div><div className="text-muted-foreground mt-1 text-xs">What remains after amounts owed</div></div>
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Assets" value={formatUSD(nw.assets)} />
        <StatCard
          label="Liabilities"
          value={formatUSD(nw.liabilities)}
          accent={nw.liabilities > 0 ? "down" : "none"}
        />
        <StatCard
          label="Accounts"
          value={accs.length}
          sub={`across ${institutions} institution${institutions === 1 ? "" : "s"}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="gap-0 py-0 lg:col-span-2">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Accounts</CardTitle>
          </CardHeader>
          <div className="divide-y">
            {accs.slice(0, 6).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-6 py-3">
                <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-full">
                  <AccountIcon type={a.type} className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="text-muted-foreground text-xs">
                    {ACCOUNT_TYPE_META[a.type].label}
                  </div>
                </div>
                <div
                  className={cn(
                    "ml-auto text-sm font-medium tabular-nums",
                    !a.isAsset && "text-negative",
                  )}
                >
                  {formatUSD(a.currentBalanceCents)}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t p-2">
            <Link
              href="/accounts"
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "w-full justify-between",
              )}
            >
              View all accounts
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {uncategorized > 0 && (
              <Link
                href="/transactions"
                className="hover:bg-accent flex items-center gap-3 rounded-lg border p-3 transition-colors"
              >
                <CircleAlert className="size-5 shrink-0 text-warning" />
                <div className="text-sm">
                  <div className="font-medium">
                    {uncategorized.toLocaleString()} uncategorized
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Categorize to unlock spending insights
                  </div>
                </div>
                <ArrowRight className="text-muted-foreground ml-auto size-4" />
              </Link>
            )}
            {recurringFlags > 0 && (
              <Link
                href="/recurring"
                className="hover:bg-accent flex items-center gap-3 rounded-lg border p-3 transition-colors"
              >
                <CircleAlert className="size-5 shrink-0 text-negative" />
                <div className="text-sm">
                  <div className="font-medium">
                    {recurringFlags} recurring flagged
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Price hikes or missed payments
                  </div>
                </div>
                <ArrowRight className="text-muted-foreground ml-auto size-4" />
              </Link>
            )}
            {uncategorized === 0 && recurringFlags === 0 && (
              <div className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
                <CheckCircle2 className="size-5 text-positive" />
                All caught up.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Financial history</CardTitle>
            <CardDescription>How your net worth and monthly cash flow are moving over time.</CardDescription>
          </div>
          <Link href="/history" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Full history <ArrowRight className="size-3.5" />
          </Link>
        </CardHeader>
        <CardContent>
          {historyRows.length === 0 ? (
            <p className="text-muted-foreground text-sm">History will appear after your first sync or net-worth checkpoint.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {historyRows.slice(0, 3).map((row) => (
                <Link key={row.key} href={`/history?at=${row.key}`} className="hover:bg-muted focus-visible:ring-ring rounded-lg border p-3 transition-colors focus-visible:ring-2">
                  <div className="text-muted-foreground text-xs">{row.label}</div>
                  <div className="mt-1 text-sm font-semibold tabular-nums">{formatUSD(row.netWorthCents)}</div>
                  <div className={cn("mt-1 text-xs tabular-nums", row.savedCents < 0 ? "text-negative" : "text-positive")}>
                    {row.savedCents >= 0 ? "Saved " : "Spent over income "}{formatUSD(Math.abs(row.savedCents))}
                  </div>
                  {row.retirementContributionCents > 0 && (
                    <div className="mt-1 text-xs tabular-nums text-info">
                      Retirement deposited {formatUSD(row.retirementContributionCents)}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
