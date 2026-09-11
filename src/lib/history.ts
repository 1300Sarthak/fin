import { db } from "@/db";
import { accounts, transactions, categories } from "@/db/schema";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import {
  parseISO,
  parse,
  startOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  subWeeks,
  subMonths,
  format,
} from "date-fns";
import { isoDate } from "@/lib/format";
import { resolveInclusion, getNetWorthSeries } from "@/lib/networth";
import { getAccountTotals } from "@/lib/queries";
import { getMilestones } from "@/lib/milestones";
import { classifyInvestmentActivity, contributionAmountCents } from "@/lib/investment-activity";

export type PeriodType = "week" | "month";

const WEEK_OPTS = { weekStartsOn: 1 } as const; // Monday
const keyFmt = (t: PeriodType) => (t === "week" ? "RRRR-'W'II" : "yyyy-MM");

function periodKeyOf(d: Date, t: PeriodType): string {
  return format(d, keyFmt(t));
}
function periodBounds(d: Date, t: PeriodType): { start: Date; end: Date } {
  return t === "week"
    ? { start: startOfWeek(d, WEEK_OPTS), end: endOfWeek(d, WEEK_OPTS) }
    : { start: startOfMonth(d), end: endOfMonth(d) };
}
function periodLabel(start: Date, t: PeriodType): string {
  return t === "week" ? `Week of ${format(start, "MMM d")}` : format(start, "MMMM yyyy");
}
/** Parse a period key back to a representative date (for the detail view). */
function keyToDate(key: string, t: PeriodType): Date | null {
  const d = parse(key, keyFmt(t), new Date());
  return Number.isNaN(d.getTime()) ? null : d;
}

/* -------------------------------- period list -------------------------------- */

export type PeriodRow = {
  key: string;
  label: string;
  start: string;
  end: string;
  netWorthCents: number;
  changeCents: number;
  changePct: number | null;
  incomeCents: number;
  retirementContributionCents: number;
  earnedAndInvestedCents: number;
  spendingCents: number;
  savedCents: number;
};

/**
 * Net worth at the close of each week/month, plus that period's income, spending
 * and net saved — derived from the authoritative daily snapshot series, the
 * manually-recorded net-worth milestones, and the transaction ledger. Most-recent
 * period first.
 */
export async function getPeriodHistory(periodType: PeriodType): Promise<PeriodRow[]> {
  const { includeIds, allActiveIds } = await resolveInclusion(undefined);
  const ids = [...includeIds];
  const totals = await getAccountTotals(ids);
  const series = await getNetWorthSeries({ range: "MAX", includeIds, totals, allActiveIds });

  // Within each period the latest-dated point wins → end-of-period net worth.
  // We seed from BOTH the snapshot-derived daily series (recent, account-backed)
  // and the manual net-worth milestones (older, spanning multiple years) so the
  // table covers every period we have any data for — not just the snapshot window.
  const byPeriod = new Map<
    string,
    { net: number; label: string; start: Date; end: Date; at: Date }
  >();
  const consider = (d: Date, net: number) => {
    const key = periodKeyOf(d, periodType);
    const prev = byPeriod.get(key);
    if (prev && d < prev.at) return; // keep the later in-period reading
    const { start, end } = periodBounds(d, periodType);
    byPeriod.set(key, { net, label: periodLabel(start, periodType), start, end, at: d });
  };
  for (const p of series.points) consider(parseISO(p.date), p.net);
  for (const m of await getMilestones()) consider(parseISO(m.date), m.totalCents);
  if (byPeriod.size === 0) return [];

  const incomeByPeriod = new Map<string, number>();
  const retirementByPeriod = new Map<string, number>();
  const spendByPeriod = new Map<string, number>();
  if (ids.length) {
    const txs = await db
      .select({ postedAt: transactions.postedAt, amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, categoryName: categories.name, categoryKind: categories.kind, accountType: accounts.type, accountName: accounts.name, isRefund: transactions.isRefund })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          inArray(transactions.accountId, ids),
          eq(transactions.isTransfer, false),
          eq(transactions.isExcluded, false),
          gte(transactions.postedAt, startOfDay(parseISO(series.startDate))),
        ),
      );
    for (const t of txs) {
      const key = periodKeyOf(t.postedAt, periodType);
      const investmentAccount = t.accountType === "brokerage" || t.accountType === "ira" || t.accountType === "crypto";
      const retirementContribution = investmentAccount && classifyInvestmentActivity(t).kind === "contribution" && (t.accountType === "ira" || /\b401\s?\(?k\)?|403\s?\(?b\)?|retirement\b/i.test(t.accountName));
      if (retirementContribution) {
        retirementByPeriod.set(key, (retirementByPeriod.get(key) ?? 0) + contributionAmountCents(t.amountCents));
      } else if (!investmentAccount && t.amountCents > 0 && !t.isRefund && t.categoryKind !== "transfer" && t.categoryKind !== "investment") {
        incomeByPeriod.set(key, (incomeByPeriod.get(key) ?? 0) + t.amountCents);
      } else if (!investmentAccount && t.amountCents < 0 && t.categoryKind !== "transfer" && t.categoryKind !== "investment") {
        spendByPeriod.set(key, (spendByPeriod.get(key) ?? 0) + -t.amountCents);
      }
    }
  }

  const keys = [...byPeriod.keys()].sort(); // chronological
  const rows: PeriodRow[] = [];
  let prevNet: number | null = null;
  for (const key of keys) {
    const info = byPeriod.get(key)!;
    const incomeCents = incomeByPeriod.get(key) ?? 0;
    const retirementContributionCents = retirementByPeriod.get(key) ?? 0;
    const spendingCents = spendByPeriod.get(key) ?? 0;
    const changeCents = prevNet == null ? 0 : info.net - prevNet;
    const changePct =
      prevNet == null || prevNet === 0 ? null : changeCents / Math.abs(prevNet);
    rows.push({
      key,
      label: info.label,
      start: isoDate(info.start),
      end: isoDate(info.end),
      netWorthCents: info.net,
      changeCents,
      changePct,
      incomeCents,
      retirementContributionCents,
      earnedAndInvestedCents: incomeCents + retirementContributionCents,
      spendingCents,
      savedCents: incomeCents - spendingCents,
    });
    prevNet = info.net;
  }
  rows.reverse();
  return rows;
}

/* ----------------------------- period breakdown ------------------------------ */

export type CatFlow = { name: string; cents: number; deltaCents: number };
export type PeriodBreakdown = {
  key: string;
  label: string;
  income: CatFlow[];
  spending: CatFlow[];
  incomeTotal: number;
  spendingTotal: number;
};

type Flows = Map<string, { income: number; spending: number }>;

async function categoryFlows(ids: number[], start: Date, end: Date): Promise<Flows> {
  const flows: Flows = new Map();
  if (ids.length === 0) return flows;
  const rows = await db
    .select({
      name: categories.name,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        inArray(transactions.accountId, ids),
        eq(transactions.isTransfer, false),
        eq(transactions.isExcluded, false),
        gte(transactions.postedAt, start),
        lte(transactions.postedAt, end),
      ),
    );
  for (const r of rows) {
    const name = r.name ?? "Uncategorized";
    const f = flows.get(name) ?? { income: 0, spending: 0 };
    if (r.amountCents > 0) f.income += r.amountCents;
    else f.spending += -r.amountCents;
    flows.set(name, f);
  }
  return flows;
}

/** Where money came in and went out for one period, with deltas vs the prior period. */
export async function getPeriodBreakdown(
  periodType: PeriodType,
  periodKey: string,
): Promise<PeriodBreakdown | null> {
  const repr = keyToDate(periodKey, periodType);
  if (!repr) return null;
  const { start, end } = periodBounds(repr, periodType);
  const prevRepr = periodType === "week" ? subWeeks(start, 1) : subMonths(start, 1);
  const prev = periodBounds(prevRepr, periodType);

  const { includeIds } = await resolveInclusion(undefined);
  const ids = [...includeIds];

  const [cur, prevFlows] = await Promise.all([
    categoryFlows(ids, start, end),
    categoryFlows(ids, prev.start, prev.end),
  ]);

  const income: CatFlow[] = [];
  const spending: CatFlow[] = [];
  for (const [name, f] of cur) {
    const p = prevFlows.get(name) ?? { income: 0, spending: 0 };
    if (f.income > 0) income.push({ name, cents: f.income, deltaCents: f.income - p.income });
    if (f.spending > 0)
      spending.push({ name, cents: f.spending, deltaCents: f.spending - p.spending });
  }
  income.sort((a, b) => b.cents - a.cents);
  spending.sort((a, b) => b.cents - a.cents);

  return {
    key: periodKey,
    label: periodLabel(start, periodType),
    income,
    spending,
    incomeTotal: income.reduce((s, x) => s + x.cents, 0),
    spendingTotal: spending.reduce((s, x) => s + x.cents, 0),
  };
}
