/**
 * The spending page's headline for any inclusive day range: made / spent / net
 * from the spendable-account view (`getCashflow`), and the burn rate from the
 * household engine (`fin burn`), so the page and both CLI commands agree.
 */
import { addDays, addMonths, differenceInCalendarDays, endOfMonth, format, parseISO, subMonths, subYears } from "date-fns";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { getCashflow, type Cashflow, type MonthRange } from "@/lib/spending";
import { getBurnReportForDays } from "@/lib/burn";
import { pacificCalendarDate } from "@/lib/calendar";
import { projectMonthEnd } from "@/lib/budget-groups-core";

const day = (d: Date) => format(d, "yyyy-MM-dd");

/** A MonthRange-shaped window over inclusive YYYY-MM-DD days, for the spending queries. */
export function daySpan(from: string, to: string): MonthRange {
  const start = parseISO(from);
  const end = new Date(`${to}T23:59:59.999`);
  return { start, end, key: from.slice(0, 7), label: `${from} – ${to}` };
}

/** First day with any ledger activity; all-time ranges start here. */
export async function firstActivityDay(): Promise<string | null> {
  const row = await db.select({ at: transactions.postedAt }).from(transactions).orderBy(asc(transactions.postedAt)).limit(1).get();
  return row ? day(row.at) : null;
}

/**
 * Resolve a possibly-open range against the ledger and today. A `to` in the
 * future is clipped to today so "this month" averages over days that happened.
 */
export async function concreteRange(from: string | null, to: string | null, today = pacificCalendarDate()) {
  const end = !to || to > today ? today : to;
  const start = from ?? (await firstActivityDay()) ?? end;
  return { from: start <= end ? start : end, to: end };
}

/**
 * The comparison window. Month-aligned ranges compare against the same days of
 * the previous month(s); a year-to-date range against last year's; anything
 * else against the equal-length window just before it.
 */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const f = parseISO(from);
  const t = parseISO(to);
  // Year to date (Jan 1 into a later month) compares with last year's same window;
  // January alone is an ordinary month and compares with December.
  if (from.endsWith("-01-01") && to.slice(5, 7) !== "01") return { from: day(subYears(f, 1)), to: day(subYears(t, 1)) };
  if (from.endsWith("-01")) {
    const months = (t.getFullYear() - f.getFullYear()) * 12 + t.getMonth() - f.getMonth() + 1;
    const pf = subMonths(f, months);
    // A whole month compares against the whole previous month, not its first N days.
    const pt = day(t) === day(endOfMonth(t)) ? endOfMonth(subMonths(t, months)) : subMonths(t, months);
    return { from: day(pf), to: day(pt) };
  }
  const length = differenceInCalendarDays(t, f) + 1;
  return { from: day(addDays(f, -length)), to: day(addDays(f, -1)) };
}

export type SpendingSummary = {
  from: string;
  to: string;
  days: number;
  cashflow: Cashflow;
  /** From the burn engine: household earned and net spent, and spent ÷ take-home. */
  burn: { earnedCents: number; takeHomeCents: number; netSpendCents: number; savedCents: number; burnPct: number };
  dailyAvgCents: number;
  /** Only for a range that is the current month so far. Null `previous` = no ledger activity then. */
  projectedMonthEndCents: number | null;
  previous: { from: string; to: string; cashflow: Cashflow; burnPct: number } | null;
};

export async function getSpendingSummary(
  range: { from: string | null; to: string | null },
  accountIds?: number[],
  today = pacificCalendarDate(),
): Promise<SpendingSummary> {
  const { from, to } = await concreteRange(range.from, range.to, today);
  const prev = range.from ? previousPeriod(from, to) : null;
  const [cashflow, burn, prevFlow, prevBurn] = await Promise.all([
    getCashflow(daySpan(from, to), accountIds),
    getBurnReportForDays(from, to),
    prev ? getCashflow(daySpan(prev.from, prev.to), accountIds) : null,
    prev ? getBurnReportForDays(prev.from, prev.to) : null,
  ]);
  const days = differenceInCalendarDays(parseISO(to), parseISO(from)) + 1;
  const monthStart = `${today.slice(0, 7)}-01`;
  const isMonthToDate = from === monthStart && to === today;
  const daysInMonth = differenceInCalendarDays(addMonths(parseISO(monthStart), 1), parseISO(monthStart));
  const t = burn.total;
  return {
    from,
    to,
    days,
    cashflow,
    burn: {
      earnedCents: t.earnedCents,
      takeHomeCents: t.takeHomeCents,
      netSpendCents: t.netSpendCents,
      savedCents: t.savedCents,
      burnPct: t.burnPct,
    },
    dailyAvgCents: Math.round(cashflow.spendingCents / Math.max(days, 1)),
    projectedMonthEndCents: isMonthToDate ? projectMonthEnd(cashflow.spendingCents, days, daysInMonth) : null,
    // A window before the ledger starts would compare against zeros; say nothing instead.
    previous: prev && prevFlow && prevBurn && prevBurn.rows.length > 0
      ? { ...prev, cashflow: prevFlow, burnPct: prevBurn.total.burnPct }
      : null,
  };
}

export type CashflowBucket = { month: string; from: string; to: string; income: number; expense: number; inRange: boolean };

/**
 * Whole-month in/out for the trend chart. A short range still shows six months
 * of context ending at it; a long one shows its own months, at most 24.
 */
export async function getCashflowBuckets(from: string, to: string, accountIds?: number[]): Promise<CashflowBucket[]> {
  const last = parseISO(`${to.slice(0, 7)}-01`);
  const first = parseISO(`${from.slice(0, 7)}-01`);
  const span = (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth() + 1;
  const count = Math.min(Math.max(span, 6), 24);
  const months = Array.from({ length: count }, (_, i) => subMonths(last, count - 1 - i));
  const flows = await Promise.all(months.map((m) => getCashflow(daySpan(day(m), day(endOfMonth(m))), accountIds)));
  return months.map((m, i) => {
    const key = format(m, "yyyy-MM");
    return {
      month: key,
      from: day(m),
      to: day(endOfMonth(m)),
      income: flows[i].incomeCents,
      expense: flows[i].spendingCents,
      inRange: key >= from.slice(0, 7) && key <= to.slice(0, 7),
    };
  });
}
