import Link from "next/link";
import { format, subMonths, addMonths, endOfMonth } from "date-fns";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { SpendingExplorer } from "@/components/spending-explorer";
import { CashflowTrendChart } from "@/components/cashflow-trend-chart";
import { BudgetDialog } from "@/components/budget-dialog";
import { AccountFilter } from "@/components/account-filter";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PieChart, ChevronLeft, ChevronRight } from "lucide-react";
import {
  monthRange,
  getCashflow,
  getSpendingByCategory,
  getSpendingByAccount,
  getMonthlyTrend,
  getTopMerchants,
  getBudgetsWithActual,
  getSpendingTransactions,
} from "@/lib/spending";
import {
  getCategoriesForSelect,
  countTransactions,
  getSpendableAccounts,
} from "@/lib/queries";
import { formatUSD, formatSigned } from "@/lib/format";
import { cn } from "@/lib/utils";

const catKey = (id: number | null) => (id == null ? "none" : String(id));

export const dynamic = "force-dynamic";

function barColor(pct: number) {
  if (pct >= 1) return "bg-negative";
  if (pct >= 0.8) return "bg-warning";
  return "bg-positive";
}

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; account?: string; category?: string }>;
}) {
  const { month, account, category } = await searchParams;
  const validMonth = typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const requestedAccountId = typeof account === "string" && /^\d+$/.test(account) ? Number(account) : undefined;
  const initialCategoryId = typeof category === "string" && /^(none|\d+)$/.test(category) ? category : undefined;
  const r = monthRange(validMonth ? month : undefined);
  const [accounts, cats] = await Promise.all([getSpendableAccounts(), getCategoriesForSelect()]);
  const accountId = accounts.some((item) => item.id === requestedAccountId)
    ? requestedAccountId
    : undefined;
  // The spending queries take a list of account ids (undefined = all spendable).
  const accountIds = accountId !== undefined ? [accountId] : undefined;
  const [cashflow, byCategory, byAccount, trend, merchants, budgetRows, total, explorerTransactions] =
    await Promise.all([
      getCashflow(r, accountIds),
      getSpendingByCategory(r, accountIds),
      getSpendingByAccount(r, accountIds),
      getMonthlyTrend(6, accountId),
      getTopMerchants(r, 8, accountIds),
      getBudgetsWithActual(r, accountIds),
      countTransactions(),
      getSpendingTransactions(r, accountIds),
    ]);

  if (total === 0) {
    return (
      <>
        <PageHeader
          title="Spending"
          description="Where your money goes — by category, merchant, and month."
        />
        <EmptyState
          icon={PieChart}
          title="Nothing to analyse yet"
          description={NO_DATA_DESCRIPTION}
          action={<ConnectDataActions />}
        />
      </>
    );
  }

  const prev = format(subMonths(r.start, 1), "yyyy-MM");
  const next = format(addMonths(r.start, 1), "yyyy-MM");
  // daily average: elapsed days this month, or full days for a past month
  const isCurrentMonth = r.key === format(new Date(), "yyyy-MM");
  const daysElapsed = isCurrentMonth
    ? new Date().getDate()
    : endOfMonth(r.start).getDate();
  const dailyAvg = Math.round(cashflow.spendingCents / Math.max(1, daysElapsed));

  // The interactive explorer receives the complete, already-filtered month of
  // spending activity. It can then combine category and card selections instantly.
  // preserve the account filter across month navigation
  const acctQS = accountId !== undefined ? `&account=${accountId}` : "";

  return (
    <>
      <PageHeader
        title="Spending"
        description="Where your money goes — by category, merchant, and month."
      >
        <AccountFilter accounts={accounts} />
        <BudgetDialog categories={cats} />
      </PageHeader>

      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/spending?month=${prev}${acctQS}`}
          className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-8")}
          aria-label="Previous month"
        >
          <ChevronLeft className="size-4" />
        </Link>
        <span className="min-w-40 text-center text-sm font-medium">{r.label}</span>
        <Link
          href={`/spending?month=${next}${acctQS}`}
          className={cn(buttonVariants({ variant: "outline", size: "icon" }), "size-8")}
          aria-label="Next month"
        >
          <ChevronRight className="size-4" />
        </Link>
      </div>

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-4 py-5">
          <div>
            <div className="text-muted-foreground text-xs">Made</div>
            <div className="text-2xl font-semibold text-positive tabular-nums">
              {formatUSD(cashflow.incomeCents)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Spent</div>
            <div className="text-2xl font-semibold text-negative tabular-nums">
              {formatUSD(cashflow.spendingCents)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Net</div>
            <div
              className={cn(
                "text-2xl font-semibold tabular-nums",
                cashflow.net >= 0 ? "text-positive" : "text-negative",
              )}
            >
              {formatSigned(cashflow.net)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Daily avg spend</div>
            <div className="text-2xl font-semibold tabular-nums">{formatUSD(dailyAvg)}</div>
            <div className="text-muted-foreground text-xs">
              over {daysElapsed} day{daysElapsed === 1 ? "" : "s"}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Spending breakdown · {r.label}</CardTitle>
        </CardHeader>
        <CardContent>
          <SpendingExplorer
            categories={byCategory.map((c) => ({
              id: catKey(c.categoryId),
              name: c.name,
              spentCents: c.spentCents,
              count: c.count,
              pct: c.pct,
            }))}
            cards={byAccount.map((a) => ({
              id: String(a.accountId),
              name: a.name,
              spentCents: a.spentCents,
              count: a.count,
            }))}
            transactions={explorerTransactions}
            categoriesForSelect={cats}
            initialCategoryId={initialCategoryId}
          />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Cash flow (6 months)</CardTitle>
        </CardHeader>
        <CardContent>
          <CashflowTrendChart data={trend} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top merchants</CardTitle>
          </CardHeader>
          <CardContent>
            {merchants.length === 0 ? (
              <p className="text-muted-foreground text-sm">No merchants this month.</p>
            ) : (
              <div className="divide-y">
                {merchants.map((m) => (
                  <div
                    key={m.merchant}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <span className="truncate">{m.merchant}</span>
                    <div className="text-right">
                      <div className="tabular-nums">{formatUSD(m.spentCents)}</div>
                      <div className="text-muted-foreground text-xs">
                        {m.count} {m.count === 1 ? "txn" : "txns"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Budgets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {budgetRows.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No budgets yet. Use “Set budget” to track spending against a limit.
              </p>
            ) : (
              budgetRows.map((b) => (
                <div key={b.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{b.name}</span>
                    <span
                      className={cn("tabular-nums", b.pct >= 1 && "text-negative")}
                    >
                      {formatUSD(b.spentCents)} / {formatUSD(b.limitCents)}
                    </span>
                  </div>
                  <div className="bg-muted h-2 overflow-hidden rounded-full">
                    <div
                      className={cn("h-full rounded-full", barColor(b.pct))}
                      style={{ width: `${Math.min(100, b.pct * 100)}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
