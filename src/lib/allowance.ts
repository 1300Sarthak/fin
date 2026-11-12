import { getCashflow, monthRange, type MonthRange } from "@/lib/spending";
import { getUpcomingBills } from "@/lib/forecast";
import { getConfigCents } from "@/lib/config";
import { pacificCalendarDate } from "@/lib/calendar";
import { getBudgetGroupsReport, projectMonthEnd } from "@/lib/budget-groups";

/**
 * "What can I spend today?" — the number the phone app opens on.
 *
 * Deliberately a different question from `getCashflow`, which reports what
 * already happened. This looks forward: it takes the month's budget, subtracts
 * what is already gone and what is already promised to a subscription, and
 * spreads only the genuinely uncommitted remainder across the days left.
 *
 * Committed bills are netted out rather than left in the daily rate because a
 * subscription is not a choice the user makes on a Tuesday. Folding it into the
 * per-day number would quietly overstate what is safe to spend on lunch.
 */
export type Allowance = {
  monthKey: string;
  budgetCents: number | null;
  /**
   * Where the budget came from. With budget groups set, the monthly budget is
   * their sum (a catch-all keeps it covering everything); otherwise the single
   * `monthly_budget_cents` config value, as before. With groups, `spentCents`
   * is what the groups count: everything when a catch-all exists, otherwise
   * only the budgeted categories, so the two sides measure the same thing.
   */
  budgetSource: "groups" | "config" | null;
  spentCents: number;
  committedCents: number;
  /** budget − spent. Includes money already promised to bills. */
  remainingCents: number;
  /** remainingCents − committedCents. What is actually free to choose. */
  freeCents: number;
  daysInMonth: number;
  daysElapsed: number;
  daysRemaining: number;
  /** freeCents spread over the days left. Null when no budget is set. */
  perDayCents: number | null;
  /** What the month is on track to reach at the current rate. */
  paceCents: number;
  projectedCents: number;
  /** True when spending has already passed the budget. */
  isOver: boolean;
};

function daysInMonth(r: MonthRange): number {
  return r.end.getUTCDate() > 0 ? new Date(r.end).getDate() : 30;
}

/**
 * `today` is the Pacific calendar date, matching every other date-sensitive
 * surface in the app. A month in the past is treated as fully elapsed so the
 * per-day figure does not divide by a negative.
 */
export async function getAllowance(month?: string): Promise<Allowance> {
  const r = monthRange(month);
  const total = daysInMonth(r);
  const today = pacificCalendarDate();
  const isCurrentMonth = today.startsWith(r.key);
  const elapsed = isCurrentMonth
    ? Number(today.slice(8, 10))
    : today > r.key
      ? total
      : 0;
  const daysElapsed = Math.min(Math.max(elapsed, 0), total);
  const daysRemaining = total - daysElapsed;

  const [flow, configCents, report] = await Promise.all([
    getCashflow(r),
    getConfigCents("monthly_budget_cents"),
    getBudgetGroupsReport(r.key),
  ]);
  const hasGroups = report.groups.length > 0;
  const budgetCents = hasGroups ? report.total.limitCents : configCents;
  const budgetSource = hasGroups ? "groups" : configCents == null ? null : "config";
  const spentCents = hasGroups ? report.total.spentCents : flow.spendingCents;

  // Only bills landing before month end are committed against this budget.
  const bills = daysRemaining > 0 ? await getUpcomingBills(daysRemaining) : [];
  // Bills carry no category, so with groups they only count against a budget
  // that covers everything (a catch-all). Otherwise a rent bill would eat a
  // Food-only budget it has nothing to do with.
  const billsCount = !hasGroups || report.groups.some((g) => g.catchAll);
  const committedCents = billsCount
    ? bills.filter((b) => b.dueAt <= r.end).reduce((sum, b) => sum + b.amountCents, 0)
    : 0;

  const remainingCents = budgetCents == null ? 0 : budgetCents - spentCents;
  const freeCents = Math.max(remainingCents - committedCents, 0);
  const paceCents = daysElapsed > 0 ? Math.round(spentCents / daysElapsed) : 0;

  return {
    monthKey: r.key,
    budgetCents,
    budgetSource,
    spentCents,
    committedCents,
    remainingCents,
    freeCents,
    daysInMonth: total,
    daysElapsed,
    daysRemaining,
    perDayCents:
      budgetCents == null || daysRemaining <= 0
        ? null
        : Math.floor(freeCents / daysRemaining),
    paceCents,
    projectedCents: projectMonthEnd(spentCents, daysElapsed, total),
    isOver: budgetCents != null && spentCents > budgetCents,
  };
}
