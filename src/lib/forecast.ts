import { db } from "@/db";
import { accounts, appConfig, recurringSeries } from "@/db/schema";
import { eq } from "drizzle-orm";
import { addDays, differenceInCalendarDays, startOfDay } from "date-fns";
import { ACCOUNT_TYPE_META } from "@/lib/accounts";
import {
  CADENCE_DAYS,
  statusOf,
  type Cadence,
  type SeriesStatus,
} from "@/lib/recurring";
import { isoDate } from "@/lib/format";

/**
 * Forward-looking companion to `recurring.ts`: that module answers "what did I
 * sign up for", this one answers "what hits my account next, and does it fit".
 */

// Money parked in these isn't available to pay a bill next Tuesday.
const INVESTMENT_ACCOUNT_TYPES = new Set(["brokerage", "ira", "crypto"]);

/** Untyped `app_config` key — same direct-read pattern as lib/ingest/sync.ts. */
export const LOW_BALANCE_KEY = "low_balance_threshold_cents";
export const LOW_BALANCE_DEFAULT_CENTS = 10_000; // $100 of headroom

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/* -------------------------------- upcoming bills ------------------------------- */

export type UpcomingBill = {
  seriesId: number;
  name: string;
  cadence: Cadence;
  status: SeriesStatus;
  /** What we expect to be charged — the latest price, not the historical median. */
  amountCents: number;
  expectedAmountCents: number;
  dueAt: Date;
  /** Calendar days from today; 0 = due today. */
  daysAway: number;
  /** The series is overdue, so this date is a roll-forward guess, not a schedule. */
  isLate: boolean;
  accountId: number | null;
  categoryId: number | null;
};

/**
 * Every date in [from, to] a series with this anchor + cadence lands on. An
 * overdue anchor is stepped forward first (a missed charge doesn't stay pinned
 * in the past), which is also what makes a weekly series appear ~4x in a month.
 */
function occurrencesIn(
  anchor: Date,
  stepDays: number,
  from: Date,
  to: Date,
): Date[] {
  let d = startOfDay(anchor);
  const behind = differenceInCalendarDays(from, d);
  if (behind > 0) d = addDays(d, Math.ceil(behind / stepDays) * stepDays);

  const out: Date[] = [];
  while (d <= to) {
    out.push(d);
    d = addDays(d, stepDays);
  }
  return out;
}

export async function getUpcomingBills(days = 30): Promise<UpcomingBill[]> {
  const rows = await db.select().from(recurringSeries);
  const from = startOfDay(new Date());
  const to = addDays(from, days);

  const bills: UpcomingBill[] = [];
  for (const r of rows) {
    // `canceled` is set by detection; `cancelled` intent is the user saying they
    // already killed it — neither should show up as money going out.
    if (r.status === "canceled" || r.cancelIntent === "cancelled") continue;

    const cadence = r.cadence as Cadence;
    const stepDays = CADENCE_DAYS[cadence];
    if (!stepDays) continue; // "irregular" and friends can't be projected

    // Fall back to lastSeen + one period when the series predates nextExpectedAt.
    const anchor =
      r.nextExpectedAt ??
      (r.lastSeenAt ? addDays(r.lastSeenAt, stepDays) : null);
    if (!anchor) continue;

    const amountCents = r.lastAmountCents || r.expectedAmountCents;
    if (amountCents <= 0) continue;

    const status = statusOf({
      cadence,
      expectedAmountCents: r.expectedAmountCents,
      lastAmountCents: r.lastAmountCents,
      nextExpectedAt: r.nextExpectedAt,
      occurrences: r.occurrences,
    });

    for (const dueAt of occurrencesIn(anchor, stepDays, from, to)) {
      bills.push({
        seriesId: r.id,
        name: titleCase(r.payeeNormalized),
        cadence,
        status,
        amountCents,
        expectedAmountCents: r.expectedAmountCents,
        dueAt,
        daysAway: differenceInCalendarDays(dueAt, from),
        isLate: startOfDay(anchor) < from,
        accountId: r.accountId,
        categoryId: r.categoryId,
      });
    }
  }

  return bills.sort(
    (a, b) =>
      a.dueAt.getTime() - b.dueAt.getTime() || b.amountCents - a.amountCents,
  );
}

/* ------------------------------ balance forecast ------------------------------- */

/** Cash you could actually spend today: active asset accounts minus investments. */
export async function getSpendableBalanceCents(): Promise<number> {
  const rows = await db
    .select({ type: accounts.type, bal: accounts.currentBalanceCents })
    .from(accounts)
    .where(eq(accounts.isActive, true));

  return rows
    .filter(
      (a) =>
        ACCOUNT_TYPE_META[a.type].isAsset && !INVESTMENT_ACCOUNT_TYPES.has(a.type),
    )
    .reduce((s, a) => s + a.bal, 0);
}

export type ForecastPoint = { date: string; balanceCents: number };

export type BalanceForecast = {
  days: number;
  startingBalanceCents: number;
  /** Total projected outflow over the window. */
  billedCents: number;
  points: ForecastPoint[];
  minBalanceCents: number;
  minDate: string;
  bills: UpcomingBill[];
};

/**
 * Today's spendable cash drawn down by the projected bills, day by day. Income
 * is deliberately not modeled — a paycheck-aware version would need a detected
 * income series, and an over-optimistic forecast is worse than a pessimistic one.
 */
export async function getBalanceForecast(days = 30): Promise<BalanceForecast> {
  const [startingBalanceCents, bills] = await Promise.all([
    getSpendableBalanceCents(),
    getUpcomingBills(days),
  ]);

  const outByDay = new Map<string, number>();
  for (const b of bills) {
    const k = isoDate(b.dueAt);
    outByDay.set(k, (outByDay.get(k) ?? 0) + b.amountCents);
  }

  const from = startOfDay(new Date());
  const points: ForecastPoint[] = [];
  let balanceCents = startingBalanceCents;
  let minBalanceCents = startingBalanceCents;
  let minDate = isoDate(from);

  for (let i = 0; i <= days; i++) {
    const date = isoDate(addDays(from, i));
    balanceCents -= outByDay.get(date) ?? 0;
    points.push({ date, balanceCents });
    if (balanceCents < minBalanceCents) {
      minBalanceCents = balanceCents;
      minDate = date;
    }
  }

  return {
    days,
    startingBalanceCents,
    billedCents: bills.reduce((s, b) => s + b.amountCents, 0),
    points,
    minBalanceCents,
    minDate,
    bills,
  };
}

/* ----------------------------- low-balance warning ----------------------------- */

export type LowBalanceWarning = {
  thresholdCents: number;
  triggered: boolean;
  /** First day the projection crosses below the threshold. */
  date: string | null;
  daysAway: number | null;
  /** Projected balance on that day (the window minimum when never triggered). */
  balanceCents: number;
  /** How far under the threshold the dip goes, at its worst. */
  shortfallCents: number;
  minBalanceCents: number;
  minDate: string;
};

export async function getLowBalanceThresholdCents(): Promise<number> {
  const row = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, LOW_BALANCE_KEY))
    .get();
  const n = Number(row?.value);
  return Number.isFinite(n) && row?.value ? n : LOW_BALANCE_DEFAULT_CENTS;
}

/** Pure — lets a page reuse one forecast instead of recomputing it. */
export function lowBalanceFromForecast(
  f: BalanceForecast,
  thresholdCents: number,
): LowBalanceWarning {
  const hit = f.points.find((p) => p.balanceCents < thresholdCents);
  return {
    thresholdCents,
    triggered: !!hit,
    date: hit?.date ?? null,
    daysAway: hit
      ? f.points.findIndex((p) => p.date === hit.date)
      : null,
    balanceCents: hit ? hit.balanceCents : f.minBalanceCents,
    shortfallCents: hit ? Math.max(0, thresholdCents - f.minBalanceCents) : 0,
    minBalanceCents: f.minBalanceCents,
    minDate: f.minDate,
  };
}

export async function getLowBalanceWarning(
  thresholdCents?: number,
  days = 30,
): Promise<LowBalanceWarning> {
  const [threshold, forecast] = await Promise.all([
    thresholdCents == null ? getLowBalanceThresholdCents() : thresholdCents,
    getBalanceForecast(days),
  ]);
  return lowBalanceFromForecast(forecast, threshold);
}
