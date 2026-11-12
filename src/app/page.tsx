import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { NetWorthRangeChart, NetWorthRangeProvider } from "@/components/net-worth-range";
import { getNetWorthTimeline } from "@/lib/net-worth-timeline";
import { AccountIcon } from "@/components/account-icon";
import { buttonVariants } from "@/components/ui/button";
import { DeltaText, HelpTip, Money, Section, Stat, StatGroup } from "@/components/kit";
import { RangeSelector } from "@/components/range-selector";
import { AccountMultiselect } from "@/components/account-multiselect";
import { LayoutDashboard, ArrowRight, CheckCircle2, ChevronRight, Tags, Repeat } from "lucide-react";
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
import { formatUSD, formatDate, isoDate } from "@/lib/format";
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
  const inclusion = await resolveInclusion(accParam);
  const { includeIds, allActiveIds } = inclusion;

  const [nw, accs, uncategorized, recurringFlags, accountList, historyRows] = await Promise.all([
    getNetWorthSummary({ range, includeIds, allActiveIds }),
    getAccountsWithInstitution(),
    countUncategorized(),
    countRecurringFlags(),
    getAccountsList(),
    getPeriodHistory("month"),
  ]);

  // After the summary, which captures today's snapshots first.
  const timeline = await getNetWorthTimeline(inclusion);

  if (accs.length === 0) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Every account, one picture."
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
  const period = range === "MAX" ? "all time" : range;
  const liquid = nw.liquidMoney;
  const attention = [
    uncategorized > 0 && { href: "/transactions", icon: Tags, tone: "text-warning", title: `${uncategorized.toLocaleString()} uncategorized`, detail: "Categorize to unlock spending insights" },
    recurringFlags > 0 && { href: "/recurring", icon: Repeat, tone: "text-negative", title: `${recurringFlags} recurring flagged`, detail: "Price hikes or missed payments" },
  ].filter((item) => item !== false);

  return (
    <>
      <PageHeader title="Overview" description="Every account, one picture." actions={<AccountMultiselect accounts={accountList} included={[...includeIds]} />} />

      {/* The one loud thing on the page: net worth, its trend, and what moved it. */}
      <NetWorthRangeProvider value={range}>
      <section aria-labelledby="net-worth-label" className="bg-card rounded-2xl border">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 md:px-6 md:pt-6">
          <div className="min-w-0">
            <div id="net-worth-label" className="text-muted-foreground flex items-center gap-1 text-[13px]">
              Net worth
              <HelpTip label="About net worth">Assets minus liabilities across the included accounts. Use the account picker to leave some out.</HelpTip>
            </div>
            <div className="mt-1 text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] md:text-[46px]">
              <Money cents={nw.net} dimCents />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <DeltaText cents={nw.deltaRange} label={period} />
              <DeltaText cents={nw.deltaDay} label="today" />
              <DeltaText cents={nw.deltaWeek} label="7d" />
            </div>
          </div>
          <RangeSelector options={RANGE_OPTIONS} value={range} defaultValue="1M" />
        </div>
        <div className="px-2 pt-4 md:px-4">
          {/* Max = every point, including hand-recorded checkpoints that predate syncing. */}
          <NetWorthRangeChart points={timeline.points} realFrom={timeline.realFrom} today={isoDate(new Date())} />
          {nw.clamped ? (
            <p className="text-muted-foreground px-3 pb-1 text-xs">
              Only about {nw.series.length} days of history so far. Longer ranges fill in as you keep syncing.
            </p>
          ) : nw.partial ? (
            <p className="text-muted-foreground px-3 pb-1 text-xs">
              Shaded history before {formatDate(nw.realFrom ?? nw.startDate)} is estimated from transactions and fills in as daily snapshots accumulate.
            </p>
          ) : null}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 border-t px-5 py-4 md:px-6 lg:grid-cols-4">
          {[
            { label: "Made", cents: nw.rangeIncomeCents, tone: "text-positive" },
            { label: "Retirement deposited", cents: nw.rangeRetirementContributionCents, tone: "text-info" },
            { label: "Earned & invested", cents: nw.rangeEarnedAndInvestedCents, tone: "text-positive" },
            { label: "Spent", cents: nw.rangeSpendingCents, tone: "text-negative" },
          ].map((flow) => (
            <div key={flow.label} className="min-w-0">
              <dt className="text-muted-foreground truncate text-xs">{flow.label} <span className="text-muted-foreground/70">over {period}</span></dt>
              <dd className={cn("num mt-0.5 text-[15px] font-semibold", flow.tone)}>{formatUSD(flow.cents)}</dd>
            </div>
          ))}
        </dl>
      </section>
      </NetWorthRangeProvider>

      <StatGroup cols={4} className="mt-6">
        <Stat label="Assets" value={<Money cents={nw.assets} />} />
        <Stat label="Liabilities" value={<Money cents={nw.liabilities} />} tone={nw.liabilities > 0 ? "negative" : "none"} help="Balances owed across included accounts, not credit limits." />
        <Stat label="Liquid cash" value={<Money cents={liquid.liquidAssetsCents} />} help="Spendable account balances, excluding brokerage, IRA, and crypto. Uses the available balance when the bank supplies one. Credit limits are not cash." />
        <Stat
          label="Liquid after liabilities"
          value={<Money cents={liquid.liquidAfterLiabilitiesCents} />}
          tone={liquid.liquidAfterLiabilitiesCents < 0 ? "negative" : "positive"}
          sub={`after ${formatUSD(liquid.liabilitiesCents)} owed`}
          help="What remains of your liquid cash after paying every balance owed today."
        />
      </StatGroup>

      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
        <Section
          title="Accounts"
          description={`${accs.length} accounts across ${institutions} institution${institutions === 1 ? "" : "s"}`}
          actions={<Link href="/accounts" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground")}>View all<ArrowRight className="size-3.5" /></Link>}
          surface
        >
          <ul className="stagger divide-y">
            {accs.slice(0, 6).map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3 md:px-5">
                <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg">
                  <AccountIcon type={a.type} className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="text-muted-foreground text-xs">{ACCOUNT_TYPE_META[a.type].label}</div>
                </div>
                <Money cents={a.currentBalanceCents} tone={a.isAsset ? "none" : "negative"} className="ml-auto text-sm font-medium" />
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Needs attention">
          {attention.length === 0 ? (
            <div className="text-muted-foreground flex items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-sm">
              <CheckCircle2 className="text-positive size-4" aria-hidden="true" />
              All caught up.
            </div>
          ) : (
            <ul className="stagger space-y-2">
              {attention.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="group bg-card hover:border-foreground/15 pressable flex items-center gap-3 rounded-xl border px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <item.icon className={cn("size-4 shrink-0", item.tone)} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{item.title}</span>
                      <span className="text-muted-foreground block text-xs">{item.detail}</span>
                    </span>
                    <ChevronRight className="text-muted-foreground size-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section
        className="mt-10"
        title="Recent months"
        description="Net worth at each month's end, and what you saved."
        actions={<Link href="/history" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-muted-foreground")}>Full history<ArrowRight className="size-3.5" /></Link>}
      >
        {historyRows.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-5 text-sm">History will appear after your first sync or net-worth checkpoint.</p>
        ) : (
          <div className="stagger grid gap-3 sm:grid-cols-3">
            {historyRows.slice(0, 3).map((row) => (
              <Link key={row.key} href={`/history?at=${row.key}`} className="bg-card hover:border-foreground/15 pressable rounded-xl border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="text-muted-foreground text-xs">{row.label}</div>
                <div className="num mt-1 text-base font-semibold">{formatUSD(row.netWorthCents)}</div>
                <div className={cn("num mt-1.5 text-xs", row.savedCents < 0 ? "text-negative" : "text-positive")}>
                  {row.savedCents >= 0 ? "Saved " : "Spent over income "}{formatUSD(Math.abs(row.savedCents))}
                </div>
                {row.retirementContributionCents > 0 && (
                  <div className="num text-info mt-0.5 text-xs">Retirement deposited {formatUSD(row.retirementContributionCents)}</div>
                )}
              </Link>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
