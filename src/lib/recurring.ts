import { db } from "@/db";
import { transactions, recurringSeries } from "@/db/schema";
import { eq } from "drizzle-orm";

const DAY = 86_400_000;

export type Cadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  yearly: 365,
};

export type SeriesStatus = "active" | "price_changed" | "missed" | "new";

/* --------------------------------- math utils -------------------------------- */

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyCadence(medianDays: number): Cadence | null {
  if (medianDays >= 5 && medianDays <= 9) return "weekly";
  if (medianDays >= 12 && medianDays <= 16) return "biweekly";
  if (medianDays >= 25 && medianDays <= 35) return "monthly";
  if (medianDays >= 80 && medianDays <= 100) return "quarterly";
  if (medianDays >= 330 && medianDays <= 400) return "yearly";
  return null;
}

/* ----------------------------- pure detector core ---------------------------- */

export type SeriesInput = { postedAt: Date; amountCents: number };

export type SeriesAnalysis = {
  cadence: Cadence;
  expectedAmountCents: number; // typical (median) magnitude
  lastAmountCents: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  nextExpectedAt: Date;
  occurrences: number;
};

/**
 * Decide whether a single merchant's transactions form a recurring series.
 * Requires >=3 occurrences, a regular cadence (weekly..yearly), and reasonably
 * stable amounts (so variable spend like groceries is not treated as a sub).
 * Pure + deterministic — unit tested.
 */
export function analyzeSeries(txns: SeriesInput[]): SeriesAnalysis | null {
  if (txns.length < 3) return null;
  const sorted = [...txns].sort(
    (a, b) => a.postedAt.getTime() - b.postedAt.getTime(),
  );

  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(
      (sorted[i].postedAt.getTime() - sorted[i - 1].postedAt.getTime()) / DAY,
    );
  }
  const cadence = classifyCadence(median(intervals));
  if (!cadence) return null;

  const amounts = sorted.map((t) => Math.abs(t.amountCents));
  const med = median(amounts) || 1;
  // amount stability: typical deviation from median should be small
  const avgDev =
    amounts.reduce((s, a) => s + Math.abs(a - med), 0) / amounts.length;
  if (avgDev / med > 0.3) return null;

  const last = sorted[sorted.length - 1];
  return {
    cadence,
    expectedAmountCents: med,
    lastAmountCents: Math.abs(last.amountCents),
    firstSeenAt: sorted[0].postedAt,
    lastSeenAt: last.postedAt,
    nextExpectedAt: new Date(last.postedAt.getTime() + CADENCE_DAYS[cadence] * DAY),
    occurrences: sorted.length,
  };
}

/** Compute display status from a (possibly stored) series snapshot + "now". */
export function statusOf(
  s: {
    cadence: Cadence;
    expectedAmountCents: number;
    lastAmountCents: number;
    nextExpectedAt: Date | null;
    occurrences: number;
  },
  now = Date.now(),
): SeriesStatus {
  if (s.lastAmountCents > s.expectedAmountCents * 1.15) return "price_changed";
  if (
    s.nextExpectedAt &&
    now > s.nextExpectedAt.getTime() + CADENCE_DAYS[s.cadence] * 0.5 * DAY
  ) {
    return "missed";
  }
  if (s.occurrences <= 3) return "new";
  return "active";
}

/* ------------------------------- persistence --------------------------------- */

export type DetectSummary = { seriesDetected: number; flagged: number };

export async function detectRecurring(): Promise<DetectSummary> {
  const rows = await db
    .select({
      id: transactions.id,
      payee: transactions.payeeNormalized,
      merchant: transactions.merchantRaw,
      amountCents: transactions.amountCents,
      postedAt: transactions.postedAt,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(eq(transactions.isTransfer, false));

  // group outflows by normalized merchant
  const groups = new Map<string, typeof rows>();
  for (const t of rows) {
    if (t.amountCents >= 0 || !t.payee) continue;
    (groups.get(t.payee) ?? groups.set(t.payee, []).get(t.payee)!).push(t);
  }

  let seriesDetected = 0;
  let flagged = 0;

  for (const [payee, members] of groups) {
    const analysis = analyzeSeries(members);
    if (!analysis) continue;

    const categoryId = members.find((m) => m.categoryId != null)?.categoryId ?? null;
    const status = statusOf(analysis);

    const [series] = await db
      .insert(recurringSeries)
      .values({
        payeeNormalized: payee,
        accountId: null,
        categoryId,
        cadence: analysis.cadence,
        expectedAmountCents: analysis.expectedAmountCents,
        lastAmountCents: analysis.lastAmountCents,
        lastSeenAt: analysis.lastSeenAt,
        nextExpectedAt: analysis.nextExpectedAt,
        occurrences: analysis.occurrences,
        status,
      })
      .onConflictDoUpdate({
        target: [recurringSeries.payeeNormalized, recurringSeries.accountId],
        set: {
          categoryId,
          cadence: analysis.cadence,
          expectedAmountCents: analysis.expectedAmountCents,
          lastAmountCents: analysis.lastAmountCents,
          lastSeenAt: analysis.lastSeenAt,
          nextExpectedAt: analysis.nextExpectedAt,
          occurrences: analysis.occurrences,
          status,
        },
      })
      .returning();

    // mark member transactions
    for (const m of members) {
      await db
        .update(transactions)
        .set({ isRecurring: true, recurringSeriesId: series.id })
        .where(eq(transactions.id, m.id));
    }

    seriesDetected++;
    if (status !== "active") flagged++;
  }

  return { seriesDetected, flagged };
}

export type RecurringView = {
  id: number;
  name: string;
  cadence: Cadence;
  expectedAmountCents: number;
  lastAmountCents: number;
  nextExpectedAt: Date | null;
  occurrences: number;
  status: SeriesStatus;
};

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function getRecurringSeries(): Promise<RecurringView[]> {
  const rows = await db.select().from(recurringSeries);
  return rows
    .map((r) => {
      const cadence = r.cadence as Cadence;
      return {
        id: r.id,
        name: titleCase(r.payeeNormalized),
        cadence,
        expectedAmountCents: r.expectedAmountCents,
        lastAmountCents: r.lastAmountCents,
        nextExpectedAt: r.nextExpectedAt,
        occurrences: r.occurrences,
        status: statusOf({
          cadence,
          expectedAmountCents: r.expectedAmountCents,
          lastAmountCents: r.lastAmountCents,
          nextExpectedAt: r.nextExpectedAt,
          occurrences: r.occurrences,
        }),
      };
    })
    .sort((a, b) => {
      const order: SeriesStatus[] = ["price_changed", "missed", "new", "active"];
      return order.indexOf(a.status) - order.indexOf(b.status);
    });
}

/** Count of flagged series — surfaced on the overview. */
export async function countRecurringFlags(): Promise<number> {
  const all = await getRecurringSeries();
  return all.filter((s) => s.status !== "active").length;
}
