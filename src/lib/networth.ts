import { db } from "@/db";
import { accounts, categories, transactions, balanceSnapshots } from "@/db/schema";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { subDays, startOfDay, parseISO, differenceInCalendarDays } from "date-fns";
import { isoDate } from "@/lib/format";
import {
  getAccountTotals,
  getZeroAccountFilter,
  type AccountTotals,
} from "@/lib/queries";
import { getHideCash } from "@/lib/config";
import { captureSnapshotsForToday } from "@/lib/snapshots";
import { classifyInvestmentActivity, contributionAmountCents } from "@/lib/investment-activity";
import { calculateLiquidMoney, type LiquidMoneySummary } from "@/lib/liquid-money";

const INVESTMENT_ACCOUNT_TYPES = ["brokerage", "ira", "crypto"] as const;
export async function getLiquidMoneySummary(includeAccountIds?: number[]): Promise<LiquidMoneySummary> {
  if (includeAccountIds?.length === 0) return calculateLiquidMoney([]);
  const rows = await db
    .select({ type: accounts.type, isAsset: accounts.isAsset, currentBalanceCents: accounts.currentBalanceCents, availableBalanceCents: accounts.availableBalanceCents })
    .from(accounts)
    .where(includeAccountIds ? and(eq(accounts.isActive, true), inArray(accounts.id, includeAccountIds)) : eq(accounts.isActive, true));
  return calculateLiquidMoney(rows);
}

export type NetWorthPoint = { date: string; net: number };

export type NetWorthRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "MAX";
export const NET_WORTH_RANGES: NetWorthRange[] = ["1D", "1W", "1M", "3M", "6M", "1Y", "MAX"];

const RANGE_DAYS: Record<Exclude<NetWorthRange, "MAX">, number> = {
  "1D": 2, // 2 points so 1D draws a line, not a dot
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 182,
  "1Y": 365,
};
const MAX_CAP_DAYS = 1825; // guard against pathological CSV history (~5y)

export function parseRange(v: string | undefined): NetWorthRange {
  const up = (v ?? "").toUpperCase();
  return (NET_WORTH_RANGES as string[]).includes(up) ? (up as NetWorthRange) : "1M";
}

/* ------------------------------ account inclusion ---------------------------- */

export type ResolvedInclusion = {
  includeIds: Set<number>;
  allActiveIds: number[];
  usedOverride: boolean;
};

/**
 * Decide which active accounts count toward net worth.
 * - A live `?accounts=` URL param (even empty) is an explicit override and wins
 *   entirely; the persistent hide-cash pref is ignored for that view.
 * - No param → baseline of all active accounts, minus the Cash account if the
 *   persistent `hide_cash_from_net_worth` pref is on.
 */
export async function resolveInclusion(urlParam: string | undefined): Promise<ResolvedInclusion> {
  const active = await db
    .select({ id: accounts.id, type: accounts.type, bal: accounts.currentBalanceCents })
    .from(accounts)
    .where(eq(accounts.isActive, true));
  // $0 accounts can be hidden from the picker; they never affect net worth, so
  // dropping them from the baseline keeps the multiselect count consistent.
  // An account with transactions is kept regardless — see getZeroAccountFilter.
  const keep = await getZeroAccountFilter();
  const visible = active.filter(keep);
  const allActiveIds = visible.map((a) => a.id);

  if (urlParam !== undefined) {
    const wanted = urlParam
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const includeIds = new Set(allActiveIds.filter((id) => wanted.includes(id)));
    return { includeIds, allActiveIds, usedOverride: true };
  }

  const hideCash = await getHideCash();
  const cashIds = new Set(visible.filter((a) => a.type === "cash").map((a) => a.id));
  const includeIds = new Set(hideCash ? allActiveIds.filter((id) => !cashIds.has(id)) : allActiveIds);
  return { includeIds, allActiveIds, usedOverride: false };
}

/* -------------------------------- time series -------------------------------- */

export type NetWorthSeriesResult = {
  points: NetWorthPoint[];
  /** Earliest snapshot-backed (authoritative) day; before it the curve is
   *  transaction-reconstructed. null = no complete snapshot day in range. */
  realFrom: string | null;
  startDate: string;
  partial: boolean;
  /** True when the requested range was longer than available history, so the
   *  series was shortened to avoid a misleading flat line. */
  clamped: boolean;
};

async function earliestDataDate(ids: number[]): Promise<Date | null> {
  const firstTx = await db
    .select({ postedAt: transactions.postedAt })
    .from(transactions)
    .where(inArray(transactions.accountId, ids))
    .orderBy(asc(transactions.postedAt))
    .limit(1)
    .get();
  const firstSnap = await db
    .select({ date: balanceSnapshots.date })
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, ids))
    .orderBy(asc(balanceSnapshots.date))
    .limit(1)
    .get();
  const dates: Date[] = [];
  if (firstTx?.postedAt) dates.push(firstTx.postedAt);
  if (firstSnap?.date) dates.push(parseISO(firstSnap.date));
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a < b ? a : b));
}

/**
 * Build a daily net-worth curve for the included accounts over the range.
 * Snapshots are authoritative on days where every included account has a row
 * (the running total resyncs to them); other days are reconstructed by walking
 * backward from the current net worth and removing each day's signed,
 * non-transfer transaction deltas.
 */
export async function getNetWorthSeries(opts: {
  range: NetWorthRange;
  includeIds: Set<number>;
  totals: AccountTotals;
  allActiveIds: number[];
}): Promise<NetWorthSeriesResult> {
  const { range, includeIds, totals } = opts;
  const ids = [...includeIds];
  const today = startOfDay(new Date());

  // Clamp every range to the span of data we actually have, so 6M/1Y don't draw
  // a long flat tail of "no data" — they show all available history until more
  // accrues. (Short ranges within the data are unaffected.)
  const earliest = ids.length ? await earliestDataDate(ids) : null;
  const availableDays = earliest
    ? Math.max(1, differenceInCalendarDays(today, startOfDay(earliest)) + 1)
    : 1;
  const requestedDays = range === "MAX" ? availableDays : RANGE_DAYS[range];
  let numDays = Math.min(requestedDays, range === "MAX" ? MAX_CAP_DAYS : availableDays);
  numDays = Math.max(2, numDays); // always ≥2 so the chart renders a line
  const clamped = range !== "MAX" && RANGE_DAYS[range] > numDays;

  const startDateObj = subDays(today, numDays - 1);
  const startStr = isoDate(startDateObj);

  // Nothing included → flat-zero series of the right length.
  if (ids.length === 0) {
    const points: NetWorthPoint[] = [];
    for (let i = numDays - 1; i >= 0; i--) points.push({ date: isoDate(subDays(today, i)), net: 0 });
    return { points, realFrom: null, startDate: startStr, partial: false, clamped: false };
  }

  const snaps = await db
    .select({
      date: balanceSnapshots.date,
      accountId: balanceSnapshots.accountId,
      balanceCents: balanceSnapshots.balanceCents,
      isAsset: balanceSnapshots.isAsset,
    })
    .from(balanceSnapshots)
    .where(and(gte(balanceSnapshots.date, startStr), inArray(balanceSnapshots.accountId, ids)));

  const txs = await db
    .select({ postedAt: transactions.postedAt, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      and(
        gte(transactions.postedAt, startDateObj),
        inArray(transactions.accountId, ids),
        eq(transactions.isTransfer, false),
      ),
    );

  const snapNetByDay = new Map<string, number>();
  const snapCountByDay = new Map<string, number>();
  for (const s of snaps) {
    snapNetByDay.set(s.date, (snapNetByDay.get(s.date) ?? 0) + (s.isAsset ? s.balanceCents : -s.balanceCents));
    snapCountByDay.set(s.date, (snapCountByDay.get(s.date) ?? 0) + 1);
  }
  const dayDelta = new Map<string, number>();
  for (const t of txs) {
    const k = isoDate(t.postedAt);
    dayDelta.set(k, (dayDelta.get(k) ?? 0) + t.amountCents);
  }

  const need = includeIds.size;
  const points: NetWorthPoint[] = [];
  let running = totals.net;
  let realFrom: string | null = null;
  for (let i = 0; i < numDays; i++) {
    const key = isoDate(subDays(today, i));
    let net: number;
    if (snapCountByDay.get(key) === need) {
      net = snapNetByDay.get(key) ?? running;
      running = net; // snapshot is truth → resync, self-healing reconstruction drift
      realFrom = key; // walking backward, so this ends on the earliest complete day
    } else {
      net = running;
    }
    points.push({ date: key, net });
    running -= dayDelta.get(key) ?? 0; // step back to prior day's close
  }
  points.reverse();

  const partial = realFrom === null || startStr < realFrom;
  return { points, realFrom, startDate: startStr, partial, clamped };
}

/* --------------------------------- summary ----------------------------------- */

export type NetWorthSummary = AccountTotals & {
  range: NetWorthRange;
  series: NetWorthPoint[];
  realFrom: string | null;
  partial: boolean;
  clamped: boolean;
  startDate: string;
  deltaDay: number;
  deltaWeek: number;
  deltaMonth: number;
  deltaRange: number;
  /** income & spending over the selected range (transfers excluded). */
  rangeIncomeCents: number;
  rangeSpendingCents: number;
  /** Deposits into retirement accounts within the selected range. They are
   * visible alongside earnings but remain separate from cash income. */
  rangeRetirementContributionCents: number;
  rangeEarnedAndInvestedCents: number;
  liquidMoney: LiquidMoneySummary;
};

/**
 * Net-worth totals + a daily series for the selected range and inclusion set.
 * Callable with no args (defaults to 1M, baseline inclusion) for the chat tool.
 * Captures today's snapshots first so today is always authoritative.
 */
export async function getNetWorthSummary(args: {
  range?: NetWorthRange;
  includeIds?: Set<number>;
  allActiveIds?: number[];
} = {}): Promise<NetWorthSummary> {
  await captureSnapshotsForToday();

  const range = args.range ?? "1M";
  let includeIds = args.includeIds;
  let allActiveIds = args.allActiveIds;
  if (!includeIds || !allActiveIds) {
    const resolved = await resolveInclusion(undefined);
    includeIds = includeIds ?? resolved.includeIds;
    allActiveIds = allActiveIds ?? resolved.allActiveIds;
  }

  const ids = [...includeIds];
  const [totals, liquidMoney] = await Promise.all([getAccountTotals(ids), getLiquidMoneySummary(ids)]);
  const series = await getNetWorthSeries({ range, includeIds, totals, allActiveIds });
  const points = series.points;

  const at = (daysAgo: number): number => {
    const idx = points.length - 1 - daysAgo;
    return idx >= 0 ? points[idx].net : (points[0]?.net ?? totals.net);
  };

  // Refunds reverse spending; they are never income in cash-flow history.
  let rangeIncomeCents = 0;
  let rangeSpendingCents = 0;
  let rangeRetirementContributionCents = 0;
  if (ids.length) {
    const [row, investmentRows] = await Promise.all([db
      .select({
        income: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 AND ${transactions.isRefund} = 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
        spending: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} WHEN ${transactions.isRefund} = 1 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
      })
      .from(transactions)
      .where(
        and(
          gte(transactions.postedAt, startOfDay(parseISO(series.startDate))),
          inArray(transactions.accountId, ids),
          eq(transactions.isTransfer, false),
          eq(transactions.isExcluded, false),
        ),
      )
      .get(),
      db.select({ amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, categoryName: categories.name, categoryKind: categories.kind, accountType: accounts.type, accountName: accounts.name })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(and(gte(transactions.postedAt, startOfDay(parseISO(series.startDate))), inArray(transactions.accountId, ids), inArray(accounts.type, [...INVESTMENT_ACCOUNT_TYPES]), eq(transactions.isExcluded, false))),
    ]);
    rangeIncomeCents = row?.income ?? 0;
    rangeSpendingCents = row?.spending ?? 0;
    rangeRetirementContributionCents = investmentRows
      .filter((transaction) => classifyInvestmentActivity(transaction).kind === "contribution" && (transaction.accountType === "ira" || /\b401\s?\(?k\)?|403\s?\(?b\)?|retirement\b/i.test(transaction.accountName)))
      .reduce((sum, transaction) => sum + contributionAmountCents(transaction.amountCents), 0);
  }

  return {
    ...totals,
    range,
    series: points,
    realFrom: series.realFrom,
    partial: series.partial,
    clamped: series.clamped,
    startDate: series.startDate,
    deltaDay: totals.net - at(1),
    deltaWeek: totals.net - at(7),
    deltaMonth: totals.net - at(30),
    deltaRange: totals.net - (points[0]?.net ?? totals.net),
    rangeIncomeCents,
    rangeSpendingCents,
    rangeRetirementContributionCents,
    rangeEarnedAndInvestedCents: rangeIncomeCents + rangeRetirementContributionCents,
    liquidMoney,
  };
}
