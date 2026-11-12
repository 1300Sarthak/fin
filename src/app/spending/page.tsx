import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, PieChart } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { EmptyState, HelpTip, Money, PageHeader, RangePicker, resolveRange } from "@/components/kit";
import { SpendingFlowChart } from "@/components/spending-flow-chart";
import { SpendingBreakdown, type BreakdownItem } from "@/components/spending-breakdown";
import { SpendingAccountSelect } from "@/components/spending-account-select";
import { BudgetGroupsPanel } from "@/components/budget-groups-panel";
import { txnHref } from "@/components/spending-links";
import { getSpendingByAccount, getSpendingByCategory, getSpendingTransactions, getTopMerchants } from "@/lib/spending";
import { concreteRange, daySpan, getCashflowBuckets, getSpendingSummary } from "@/lib/spending-summary";
import { getBudgetGroupsReport, getCategoryNodes } from "@/lib/budget-groups";
import { countTransactions, getCategoriesForSelect, getSpendableAccounts } from "@/lib/queries";
import { formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const short = (iso: string, withYear = false) => format(parseISO(iso), withYear ? "MMM d, yyyy" : "MMM d");

/** Older links used `?month=YYYY-MM`; read them as that whole month. */
function withLegacyMonth(params: Params): Params {
  const month = one(params.month);
  if (!month || params.period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return params;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { ...params, period: "custom", from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export default async function SpendingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = withLegacyMonth(await searchParams);
  const range = resolveRange(params, { fallback: "this-month" });
  const accountParam = one(params.account);
  const categoryParam = one(params.category);
  const [accounts, total] = await Promise.all([getSpendableAccounts(), countTransactions()]);
  const account = accounts.find((a) => String(a.id) === accountParam)?.id;
  const accountIds = account === undefined ? undefined : [account];

  const header = (
    <PageHeader
      title="Spending"
      description="Where your money went, and how this month is pacing."
      actions={<><SpendingAccountSelect accounts={accounts} /><RangePicker value={range} fallback="this-month" /></>}
    />
  );
  if (total === 0) {
    return <>{header}<EmptyState icon={PieChart} title="Nothing to analyse yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} /></>;
  }

  const { from, to } = await concreteRange(range.from, range.to);
  const span = daySpan(from, to);
  const [summary, byCategory, byAccount, merchants, transactions, buckets, budgets, nodes, selectCategories] = await Promise.all([
    getSpendingSummary({ from: range.from, to: range.to }, accountIds),
    getSpendingByCategory(span, accountIds),
    getSpendingByAccount(span, accountIds),
    getTopMerchants(span, 30, accountIds),
    getSpendingTransactions(span, accountIds),
    getCashflowBuckets(from, to, accountIds),
    getBudgetGroupsReport(to.slice(0, 7), accountIds),
    getCategoryNodes(),
    getCategoriesForSelect(),
  ]);

  const flow = summary.cashflow;
  const prev = summary.previous;
  const spendDelta = prev ? flow.spendingCents - prev.cashflow.spendingCents : null;
  const burnDelta = prev ? summary.burn.burnPct - prev.burnPct : null;
  const link = { from, to, account };
  const nodeName = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = (id: number | null) => {
    const p = id == null ? undefined : nodeName.get(id)?.parentId;
    return p == null ? undefined : nodeName.get(p)?.name;
  };

  const items: Record<"category" | "card" | "merchant", BreakdownItem[]> = {
    category: byCategory.map((c) => ({
      id: c.categoryId == null ? "none" : String(c.categoryId),
      name: c.name,
      context: parentOf(c.categoryId),
      spentCents: c.spentCents,
      refundedCents: c.refundedCents,
      count: c.count,
      link: { category: c.name },
    })),
    card: byAccount.map((a) => ({
      id: String(a.accountId),
      name: a.name,
      spentCents: a.spentCents,
      refundedCents: a.refundedCents,
      count: a.count,
      link: { account: a.accountId },
    })),
    merchant: merchants.map((m) => ({
      id: m.merchant,
      name: m.merchant || "Unnamed merchant",
      spentCents: m.spentCents,
      count: m.count,
      link: { merchant: m.merchant },
    })),
  };
  const initialCategory = categoryParam
    ? items.category.find((c) => c.id === categoryParam || c.name.toLowerCase() === categoryParam.toLowerCase())
    : undefined;
  const expenseCategories = nodes.filter((n) => n.kind === "expense").map((n) => ({ id: n.id, name: n.name, parentId: n.parentId }));

  return (
    <>
      {header}

      {/* The one loud thing: what went out, against the period before, with the months around it. */}
      <section aria-labelledby="spent-label" className="bg-card rounded-2xl border">
        <div className="px-5 pt-5 md:px-6 md:pt-6">
          <div id="spent-label" className="text-muted-foreground flex items-center gap-1 text-[13px]">
            Spent, {short(from)} to {short(to)}
            <HelpTip label="About spent">Purchases from spendable accounts net of refunds, pending holds included. Transfers, card payments, investing and excluded rows never count.</HelpTip>
          </div>
          <Link href={txnHref({ ...link, kind: "expense" })} className="mt-1 inline-block rounded-md text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-[46px]">
            <Money cents={flow.spendingCents} dimCents />
          </Link>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {spendDelta != null && prev ? (
              <Link href={txnHref({ from: prev.from, to: prev.to, kind: "expense", account })} className="hover:text-foreground rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <SpendDelta cents={spendDelta} /> <span className="text-muted-foreground">vs {short(prev.from, prev.to.slice(0, 4) !== to.slice(0, 4))} to {short(prev.to, prev.to.slice(0, 4) !== to.slice(0, 4))} ({formatUSD(prev.cashflow.spendingCents)})</span>
              </Link>
            ) : (
              <span className="text-muted-foreground">Across {summary.days} days</span>
            )}
          </div>
        </div>
        <div className="px-2 pt-4 md:px-4">
          <SpendingFlowChart data={buckets} account={account} />
        </div>
        <dl className="bg-border mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-b-2xl border-t md:grid-cols-5">
          <HeroStat label="Made" href={txnHref({ ...link, kind: "income" })} help="Money that landed in spendable accounts. Refunds are netted out of spending instead.">
            <Money cents={flow.incomeCents} tone="positive" />
          </HeroStat>
          <HeroStat label="Net" href={txnHref({ ...link, kind: "cashflow" })} help="Made minus spent, for the same accounts. Opens exactly the rows behind both.">
            <Money cents={flow.net} signed tone="auto" />
          </HeroStat>
          <HeroStat
            label="Burn rate"
            help={`Net spending ÷ take-home pay for the whole household, the same numbers as fin burn: ${formatUSD(summary.burn.netSpendCents)} spent of ${formatUSD(summary.burn.takeHomeCents)} taken home (${formatUSD(summary.burn.earnedCents)} earned incl. pre-tax). Ignores the account filter, and take-home is not a list of transactions, so this one has no drill-down.`}
            sub={burnDelta != null ? `${burnDelta > 0 ? "+" : ""}${burnDelta.toFixed(1)} pts vs before` : `of ${formatUSD(summary.burn.takeHomeCents, false)} take-home`}
            subTone={burnDelta == null ? undefined : burnDelta > 0 ? "text-negative" : "text-positive"}
          >
            <span className={cn(summary.burn.burnPct > 100 && "text-negative")}>{summary.burn.burnPct.toFixed(1)}%</span>
          </HeroStat>
          <HeroStat label="Daily average" href={txnHref({ ...link, kind: "expense" })} help="Spent divided by the days in the range so far." sub={`over ${summary.days} ${summary.days === 1 ? "day" : "days"}`}>
            <Money cents={summary.dailyAvgCents} />
          </HeroStat>
          {summary.projectedMonthEndCents != null ? (
            <HeroStat label="Projected month end" help="This month's daily average carried to the last day." sub={budgets.groups.length ? `budget ${formatUSD(budgets.total.limitCents, false)}` : undefined} className="col-span-2 md:col-span-1">
              <span className={cn(budgets.groups.length > 0 && summary.projectedMonthEndCents > budgets.total.limitCents && "text-warning")}>
                <Money cents={summary.projectedMonthEndCents} />
              </span>
            </HeroStat>
          ) : (
            <HeroStat label="Refunded" href={`/refunds?${new URLSearchParams({ period: "custom", from, to })}`} help="Money given back against purchases, already netted out of spent." className="col-span-2 md:col-span-1">
              <Money cents={flow.refundCents} />
            </HeroStat>
          )}
        </dl>
      </section>

      <div className="mt-10">
        <BudgetGroupsPanel report={budgets} categories={expenseCategories} account={account} />
      </div>

      <div className="mt-10">
        <SpendingBreakdown
          items={items}
          transactions={transactions}
          categories={selectCategories}
          range={{ from, to, account }}
          totalCents={flow.spendingCents}
          initial={initialCategory ? { view: "category", id: initialCategory.id } : undefined}
        />
      </div>
    </>
  );
}

/** Spending going up is the bad direction, so the colours are the reverse of DeltaText's. */
function SpendDelta({ cents }: { cents: number }) {
  const up = cents > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("num inline-flex items-center gap-0.5 font-medium", up ? "text-negative" : "text-positive")}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{up ? "up" : "down"} </span>
      {formatUSD(Math.abs(cents))}
    </span>
  );
}

function HeroStat({ label, href, help, sub, subTone, className, children }: {
  label: string;
  href?: string;
  help?: string;
  sub?: string;
  subTone?: string;
  className?: string;
  children: ReactNode;
}) {
  const value = <span className="num block text-[17px] leading-6 font-semibold tracking-[-0.01em] md:text-lg">{children}</span>;
  return (
    <div className={cn("bg-card min-w-0 px-5 py-3.5 md:px-6 md:py-4", className)}>
      <dt className="text-muted-foreground flex items-center gap-1 text-[12.5px]">
        <span className="truncate">{label}</span>
        {help && <HelpTip label={`About ${label.toLowerCase()}`}>{help}</HelpTip>}
      </dt>
      <dd className="mt-0.5">
        {href ? <Link href={href} className="pressable inline-block rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring">{value}</Link> : value}
        {sub && <span className={cn("text-muted-foreground mt-0.5 block truncate text-xs", subTone)}>{sub}</span>}
      </dd>
    </div>
  );
}
