import { db } from "@/db";
import {
  transactions,
  categories,
  accounts,
  recurringSeries,
} from "@/db/schema";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  endOfMonth,
  format,
  parse,
  startOfMonth,
  subMonths,
} from "date-fns";
import { formatUSD, formatDateShort, monthLabel } from "@/lib/format";
import { statusOf, CADENCE_DAYS, type Cadence } from "@/lib/recurring";
import { INVESTMENT_ACCOUNT_TYPES, cashSweepSql } from "@/lib/cashflow-scope";

/**
 * Spending anomalies
 * ------------------
 * Turns a month of transactions into a short list of "you should look at this"
 * insights: a category running hot, a big first-time merchant, a subscription
 * that quietly went up, an outlier charge.
 *
 * The hard part is NOT finding differences — it's staying quiet. Every detector
 * therefore needs both a RATIO (this is unusual) and an ABSOLUTE gap (this is
 * worth a sentence), plus enough history to have an opinion at all. A $4 coffee
 * month becoming $9 is 2.25x and completely uninteresting; without the dollar
 * floor the list fills with noise and stops being read.
 *
 * Money in / money out
 * - Only outflows count (`amountCents < 0`); transfers and investment accounts
 *   are never spending.
 * - Rows flagged `isRefund` are skipped entirely, and a purchase that a refund
 *   is LINKED to (`refundsTxnId`) is dropped too — refunds.ts only links exact
 *   reversals, so a linked purchase was given back in full and was never really
 *   spending, let alone a spike.
 */

// These category kinds aren't discretionary spend, so they can't "spike".
const NON_SPEND_KINDS = new Set(["income", "transfer", "investment"]);

/** How far back the baselines look. */
const LOOKBACK_MONTHS = 6;
/** Below this many months of real activity we have no idea what "usual" is. */
const MIN_HISTORY_MONTHS = 3;

const SPIKE_RATIO = 2;
const SPIKE_MIN_DELTA_CENTS = 5_000;
const NEW_MERCHANT_MIN_CENTS = 15_000;
/** Sub-dollar drift on a subscription isn't a price hike, it's rounding. */
const PRICE_HIKE_MIN_CENTS = 100;

const PAYEE_MIN_HISTORY = 4;
const PAYEE_OUTLIER_RATIO = 3;
const PAYEE_OUTLIER_MIN_DELTA_CENTS = 5_000;
const CATEGORY_MIN_HISTORY = 8;
const CATEGORY_OUTLIER_RATIO = 4;
const CATEGORY_OUTLIER_MIN_DELTA_CENTS = 15_000;
/** Last resort for a purchase with no payee or category history behind it. */
const RECORD_RATIO = 8;
const RECORD_MIN_CENTS = 25_000;

const MAX_INSIGHTS = 8;

export type AnomalyKind =
  | "category_spike"
  | "new_merchant"
  | "price_hike"
  | "large_transaction";

export type AnomalySeverity = "info" | "warn";

export type SpendingAnomaly = {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** One line, already phrased for a human. */
  title: string;
  /** The evidence: what happened, and what it's being compared against. */
  detail: string;
  categoryId?: number;
  /** What happened, in cents (month spend, new price, charge size). */
  amountCents: number;
  /** The baseline it beat, in cents (usual spend, old price, typical charge). */
  comparisonCents: number;
};

/* ---------------------------------- helpers ---------------------------------- */

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** "2.4x" / "11x" — one decimal only while it still carries information. */
const ratioLabel = (r: number) =>
  `${r >= 10 ? Math.round(r) : Math.round(r * 10) / 10}x`;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: "weekly",
  biweekly: "every-two-weeks",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

type SpendRow = {
  id: number;
  postedAt: Date;
  amountCents: number;
  payee: string;
  merchant: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryKind: string;
  isRecurring: boolean;
};

/* --------------------------------- the detector -------------------------------- */

/**
 * Ranked insights for `month` (YYYY-MM, defaults to the current month).
 * Returns `[]` rather than guessing whenever the history is too thin.
 */
export async function getSpendingAnomalies(
  month?: string,
): Promise<SpendingAnomaly[]> {
  const base = month
    ? parse(`${month}-01`, "yyyy-MM-dd", new Date())
    : new Date();
  const start = startOfMonth(base);
  const end = endOfMonth(base);
  const key = format(base, "yyyy-MM");
  const label = format(base, "MMMM yyyy");
  const windowStart = startOfMonth(subMonths(start, LOOKBACK_MONTHS));
  const isCurrentMonth = key === format(new Date(), "yyyy-MM");

  const investmentAccounts = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.type, [...INVESTMENT_ACCOUNT_TYPES]));

  const [rows, refunds] = await Promise.all([
    db
      .select({
        id: transactions.id,
        postedAt: transactions.postedAt,
        amountCents: transactions.amountCents,
        payee: transactions.payeeNormalized,
        merchant: transactions.merchantRaw,
        categoryId: transactions.categoryId,
        categoryName: categories.name,
        categoryKind: sql<string>`COALESCE(${categories.kind}, 'expense')`,
        isRecurring: transactions.isRecurring,
      })
      .from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          gte(transactions.postedAt, windowStart),
          lte(transactions.postedAt, end),
          sql`${transactions.amountCents} < 0`,
          eq(transactions.isTransfer, false),
          eq(transactions.isExcluded, false),
          eq(transactions.isRefund, false),
          notInArray(transactions.accountId, investmentAccounts),
          sql`NOT ${cashSweepSql()}`,
        ),
      ),
    db
      .select({ id: transactions.refundsTxnId, amountCents: transactions.amountCents })
      .from(transactions)
      .where(
        and(
          eq(transactions.isRefund, true),
          eq(transactions.isTransfer, false),
          eq(transactions.isExcluded, false),
          sql`${transactions.amountCents} > 0`,
          isNotNull(transactions.refundsTxnId),
        ),
      ),
  ]);

  const refundedByPurchase = new Map<number, number>();
  for (const r of refunds) {
    if (r.id != null) refundedByPurchase.set(r.id, (refundedByPurchase.get(r.id) ?? 0) + r.amountCents);
  }
  // Partial refunds lower the effective purchase; only fully refunded rows
  // disappear from anomaly detection.
  const spend: SpendRow[] = rows.flatMap((r) => {
    const netCents = -r.amountCents - (refundedByPurchase.get(r.id) ?? 0);
    return netCents > 0 ? [{ ...r, amountCents: -netCents }] : [];
  });

  const thisMonth: SpendRow[] = [];
  /** categoryId -> monthKey -> cents spent */
  const catByMonth = new Map<number, Map<string, number>>();
  const catName = new Map<number, string>();
  /** payee -> this month's outflow total, count, and display name */
  const payeeNow = new Map<
    string,
    { cents: number; count: number; merchant: string }
  >();
  const payeeHistory = new Map<string, number[]>();
  const catHistory = new Map<number, number[]>();
  const allHistory: number[] = [];
  const monthsWithSpend = new Set<string>();

  for (const t of spend) {
    const cents = -t.amountCents;
    const mKey = format(t.postedAt, "yyyy-MM");
    // Uncategorized is a grab bag, not a category — a "spike" there says
    // nothing, so it is left out of the per-category baselines entirely.
    const catId = NON_SPEND_KINDS.has(t.categoryKind) ? null : t.categoryId;

    if (catId != null) {
      catName.set(catId, t.categoryName ?? "Uncategorized");
      const months = catByMonth.get(catId) ?? new Map<string, number>();
      months.set(mKey, (months.get(mKey) ?? 0) + cents);
      catByMonth.set(catId, months);
    }

    if (mKey === key) {
      thisMonth.push(t);
      if (t.payee) {
        const p = payeeNow.get(t.payee) ?? {
          cents: 0,
          count: 0,
          merchant: t.merchant || t.payee,
        };
        p.cents += cents;
        p.count += 1;
        payeeNow.set(t.payee, p);
      }
      continue;
    }

    monthsWithSpend.add(mKey);
    allHistory.push(cents);
    if (t.payee) {
      const prior = payeeHistory.get(t.payee) ?? [];
      prior.push(cents);
      payeeHistory.set(t.payee, prior);
    }
    if (catId != null) {
      const prior = catHistory.get(catId) ?? [];
      prior.push(cents);
      catHistory.set(catId, prior);
    }
  }

  // One month of data can justify nothing. Bail before any detector runs so a
  // fresh import doesn't greet the user with "every merchant is new!".
  if (monthsWithSpend.size < MIN_HISTORY_MONTHS) return [];

  const out: SpendingAnomaly[] = [];

  /* 1. category spike ---------------------------------------------------- */

  for (const [id, months] of catByMonth) {
    const current = months.get(key) ?? 0;
    if (current <= 0) continue;
    // Months with no spend are left out of the baseline: a category you touch
    // occasionally would otherwise have a median of $0 and spike every time.
    const prior = [...months].filter(([m]) => m !== key).map(([, c]) => c);
    if (prior.length < MIN_HISTORY_MONTHS) continue;

    const usual = median(prior);
    const delta = current - usual;
    if (usual <= 0 || current < usual * SPIKE_RATIO) continue;
    if (delta < SPIKE_MIN_DELTA_CENTS) continue;

    const ratio = current / usual;
    const name = catName.get(id) ?? "Uncategorized";
    out.push({
      kind: "category_spike",
      // A partial month is compared against whole ones on purpose — no
      // pro-rating, because extrapolating from three days invents spikes.
      severity: ratio >= 3 && delta >= 10_000 ? "warn" : "info",
      title: `${name} is ${ratioLabel(ratio)} your usual`,
      detail: `${formatUSD(current)} ${
        isCurrentMonth ? "so far this month" : `in ${label}`
      } vs a ${formatUSD(usual)} median across ${plural(prior.length, "earlier month")}.`,
      categoryId: id,
      amountCents: current,
      comparisonCents: usual,
    });
  }

  /* 2. new merchant, large spend ----------------------------------------- */

  const candidates = [...payeeNow].filter(
    ([, p]) => p.cents >= NEW_MERCHANT_MIN_CENTS,
  );
  const seenBefore = new Set<string>();
  if (candidates.length) {
    // "Never seen" spans the whole ledger, not just the lookback window, and
    // counts any transaction — an old refund from a merchant still means you
    // have met them before.
    const prior = await db
      .selectDistinct({ payee: transactions.payeeNormalized })
      .from(transactions)
      .where(lt(transactions.postedAt, start));
    for (const p of prior) seenBefore.add(p.payee);
  }

  const newPayees = new Set<string>();
  for (const [payee, p] of candidates) {
    if (seenBefore.has(payee)) continue;
    newPayees.add(payee);
    out.push({
      kind: "new_merchant",
      severity: p.cents >= NEW_MERCHANT_MIN_CENTS * 3 ? "warn" : "info",
      title: `First charge from ${p.merchant}`,
      detail: `${formatUSD(p.cents)} across ${plural(p.count, "charge")} — nothing from this merchant before ${label}.`,
      amountCents: p.cents,
      comparisonCents: 0,
    });
  }

  /* 3. price hike on a recurring charge ---------------------------------- */

  // A price change is a fact about right now, not about a past month, so it
  // only rides along on the current-month view. Status comes from recurring.ts
  // rather than the stored column so a stale row can't raise a false alarm.
  if (isCurrentMonth) {
    const series = await db.select().from(recurringSeries);
    for (const s of series) {
      if (s.cancelIntent === "cancelled") continue;
      const cadence = s.cadence as Cadence;
      if (!(cadence in CADENCE_DAYS)) continue;
      const status = statusOf({
        cadence,
        expectedAmountCents: s.expectedAmountCents,
        lastAmountCents: s.lastAmountCents,
        nextExpectedAt: s.nextExpectedAt,
        occurrences: s.occurrences,
      });
      if (status !== "price_changed") continue;

      const bump = s.lastAmountCents - s.expectedAmountCents;
      if (bump < PRICE_HIKE_MIN_CENTS) continue;

      const pct = bump / s.expectedAmountCents;
      const perYear = Math.round(bump * (365 / CADENCE_DAYS[cadence]));
      const name = s.payeeNormalized.replace(/\b\w/g, (c) => c.toUpperCase());
      out.push({
        kind: "price_hike",
        severity: pct >= 0.25 || bump >= 500 ? "warn" : "info",
        title: `${name} went up ${Math.round(pct * 100)}%`,
        detail: `Your ${CADENCE_LABEL[cadence]} charge moved from ${formatUSD(
          s.expectedAmountCents,
        )} to ${formatUSD(s.lastAmountCents)} — about ${formatUSD(perYear)} more a year.`,
        categoryId: s.categoryId ?? undefined,
        amountCents: s.lastAmountCents,
        comparisonCents: s.expectedAmountCents,
      });
    }
  }

  /* 4. unusually large single transaction -------------------------------- */

  const priorMax = allHistory.length ? Math.max(...allHistory) : 0;
  const allUsual = median(allHistory);
  /** Keep one outlier per payee — two $165 Amazon charges is one story. */
  const outliers = new Map<string, SpendingAnomaly>();

  for (const t of thisMonth) {
    // A recurring charge that grew is a price hike, and detector 3 owns it.
    if (t.isRecurring) continue;
    // Already reported above as a first-time merchant.
    if (newPayees.has(t.payee)) continue;

    const cents = -t.amountCents;
    const name = t.merchant || t.payee || "Unknown merchant";
    const when = formatDateShort(t.postedAt);
    let found: SpendingAnomaly | null = null;

    const byPayee = payeeHistory.get(t.payee) ?? [];
    const catPrior = t.categoryId != null ? (catHistory.get(t.categoryId) ?? []) : [];

    if (byPayee.length >= PAYEE_MIN_HISTORY) {
      const usual = median(byPayee);
      if (
        usual > 0 &&
        cents >= usual * PAYEE_OUTLIER_RATIO &&
        cents - usual >= PAYEE_OUTLIER_MIN_DELTA_CENTS
      ) {
        const ratio = cents / usual;
        found = {
          kind: "large_transaction",
          severity: ratio >= 5 && cents - usual >= 10_000 ? "warn" : "info",
          title: `${name} charge is ${ratioLabel(ratio)} its usual`,
          detail: `${formatUSD(cents)} on ${when} — you normally spend about ${formatUSD(usual)} there.`,
          categoryId: t.categoryId ?? undefined,
          amountCents: cents,
          comparisonCents: usual,
        };
      }
    } else if (catPrior.length >= CATEGORY_MIN_HISTORY) {
      const usual = median(catPrior);
      if (
        usual > 0 &&
        cents >= usual * CATEGORY_OUTLIER_RATIO &&
        cents - usual >= CATEGORY_OUTLIER_MIN_DELTA_CENTS
      ) {
        const ratio = cents / usual;
        const cat = t.categoryName ?? "this category";
        found = {
          kind: "large_transaction",
          severity: "warn",
          title: `Large ${cat} purchase: ${name}`,
          detail: `${formatUSD(cents)} on ${when} — ${ratioLabel(ratio)} the typical ${formatUSD(usual)} ${cat} purchase.`,
          categoryId: t.categoryId ?? undefined,
          amountCents: cents,
          comparisonCents: usual,
        };
      }
    } else if (
      // No payee and no category history to lean on: only speak up if it beats
      // everything else in the window outright.
      allHistory.length >= 30 &&
      cents > priorMax &&
      cents >= allUsual * RECORD_RATIO &&
      cents >= RECORD_MIN_CENTS
    ) {
      found = {
        kind: "large_transaction",
        severity: "warn",
        title: `Biggest purchase since ${monthLabel(windowStart)}: ${name}`,
        detail: `${formatUSD(cents)} on ${when} — larger than any single purchase in the last ${LOOKBACK_MONTHS} months (previous high ${formatUSD(priorMax)}).`,
        categoryId: t.categoryId ?? undefined,
        amountCents: cents,
        comparisonCents: priorMax,
      };
    }

    if (!found) continue;
    const kept = outliers.get(t.payee);
    if (!kept || found.amountCents > kept.amountCents) outliers.set(t.payee, found);
  }

  out.push(...outliers.values());

  /* rank ------------------------------------------------------------------ */

  const bySeverity: Record<AnomalySeverity, number> = { warn: 0, info: 1 };
  return out
    .sort(
      (a, b) =>
        bySeverity[a.severity] - bySeverity[b.severity] ||
        b.amountCents -
          b.comparisonCents -
          (a.amountCents - a.comparisonCents),
    )
    .slice(0, MAX_INSIGHTS);
}
