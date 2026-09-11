import { db } from "@/db";
import { recurringSeries, transactions } from "@/db/schema";
import { and, eq, inArray, lte } from "drizzle-orm";
import { CADENCE_DAYS, type Cadence } from "@/lib/recurring";

const DAY = 86_400_000;

/* ------------------------------ cancel tracker -------------------------------- */

/**
 * What the user decided about a subscription. Purely a record of intent — this
 * app never contacts a merchant or cancels anything on the user's behalf.
 * `cancel` = "I want out, not done yet"; `cancelled` = "I already cancelled it".
 */
export const CANCEL_INTENTS = ["keep", "cancel", "cancelled"] as const;
export type CancelIntent = (typeof CANCEL_INTENTS)[number];

export function isCancelIntent(value: unknown): value is CancelIntent {
  return (
    typeof value === "string" &&
    (CANCEL_INTENTS as readonly string[]).includes(value)
  );
}

export type CancelState = {
  cancelIntent: CancelIntent;
  cancelUrl: string | null;
  cancelNote: string | null;
};

/**
 * Cancel-tracker columns keyed by series id. `getRecurringSeries()` returns only
 * detection fields, so the page pulls the user's decisions from here rather than
 * widening that view.
 */
export async function getCancelStates(): Promise<Map<number, CancelState>> {
  const rows = await db
    .select({
      id: recurringSeries.id,
      cancelIntent: recurringSeries.cancelIntent,
      cancelUrl: recurringSeries.cancelUrl,
      cancelNote: recurringSeries.cancelNote,
    })
    .from(recurringSeries);

  return new Map(
    rows.map((r) => [
      r.id,
      {
        // The column is plain text at the DB level; anything unrecognized reads
        // as "keep" so a bad value can never present as a cancellation.
        cancelIntent: isCancelIntent(r.cancelIntent) ? r.cancelIntent : "keep",
        cancelUrl: r.cancelUrl,
        cancelNote: r.cancelNote,
      },
    ]),
  );
}

/* ----------------------------- free-trial detection --------------------------- */

/** An intro charge has to be at most half the eventual price to read as a trial. */
const INTRO_MAX_RATIO = 0.5;
/** Under $1 is rounding noise or a card-auth hold, not a subscription price. */
const MIN_FULL_CENTS = 100;
/** Within 20% of the typical price counts as "charged full price". */
const FULL_PRICE_TOLERANCE = 0.8;
/** Post-intro charges must be this stable (mean deviation / median) to be a price. */
const MAX_PRICE_DEVIATION = 0.3;
/** A $0 auth hold clears within a day or two — that is not a trial converting. */
const MIN_CONVERSION_DAYS = 2;
/** The real charge has to follow the intro within ~2 billing periods. */
const MAX_CONVERSION_PERIODS = 2.5;
/** Older conversions are history, not something to act on. */
const LOOKBACK_DAYS = 365;

export type EndingTrial = {
  seriesId: number;
  name: string;
  cadence: Cadence;
  /** The intro charge — 0 for a true free trial. */
  introAmountCents: number;
  introChargedAt: Date;
  /** What the subscription settled at afterwards. */
  fullAmountCents: number;
  /** First full-price charge: when the intro period actually ended. */
  endedAt: Date;
  /** How many full-price charges confirm the price. */
  fullCharges: number;
  /** "medium" = only one charge confirms the real price so far. */
  confidence: "high" | "medium";
  nextExpectedAt: Date | null;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Find subscriptions that started on a free/discounted intro and have since
 * converted to full price.
 *
 * Deliberately conservative: a single cheap charge proves nothing (merchants
 * post $0 card-auth holds, partial refunds and odd small purchases all the
 * time), so a trial is only reported when a low first charge is FOLLOWED by at
 * least one steady full-price charge within a couple of billing periods. That
 * also means a trial with no charge after it yet is never guessed at.
 *
 * Reads transactions by payee rather than by `recurringSeriesId` on purpose:
 * detection only groups outflows, so the $0 row that starts a free trial is
 * never linked to the series it belongs to.
 */
export async function getEndingTrials(now = Date.now()): Promise<EndingTrial[]> {
  const series = await db.select().from(recurringSeries);
  if (series.length === 0) return [];

  const payees = [...new Set(series.map((s) => s.payeeNormalized))];
  const charges = await db
    .select({
      payee: transactions.payeeNormalized,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      postedAt: transactions.postedAt,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.payeeNormalized, payees),
        eq(transactions.isTransfer, false),
        // Outflows plus the $0 rows that mark a free trial. Money-in (refunds,
        // reversals) says nothing about the subscription price.
        lte(transactions.amountCents, 0),
      ),
    );

  const byPayee = new Map<string, typeof charges>();
  for (const c of charges) {
    const list = byPayee.get(c.payee);
    if (list) list.push(c);
    else byPayee.set(c.payee, [c]);
  }

  const out: EndingTrial[] = [];

  for (const s of series) {
    // A subscription the user already cancelled isn't news.
    if (s.cancelIntent === "cancelled") continue;

    const cadence = s.cadence as Cadence;
    const periodDays = CADENCE_DAYS[cadence];
    if (!periodDays) continue; // "irregular" — no billing window to reason about

    const history = (byPayee.get(s.payeeNormalized) ?? [])
      .filter((c) => s.accountId == null || c.accountId === s.accountId)
      .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
    if (history.length < 2) continue;

    const [intro, ...rest] = history;
    const introCents = Math.abs(intro.amountCents);
    const restCents = rest.map((c) => Math.abs(c.amountCents));
    const fullCents = median(restCents);

    if (fullCents < MIN_FULL_CENTS) continue;
    if (introCents > fullCents * INTRO_MAX_RATIO) continue;

    // The later charges have to look like one steady price, otherwise this is
    // variable spend at a merchant that happened to start cheap.
    const deviation =
      restCents.reduce((sum, c) => sum + Math.abs(c - fullCents), 0) /
      restCents.length /
      fullCents;
    if (deviation > MAX_PRICE_DEVIATION) continue;

    const atFullPrice = rest.filter(
      (c) => Math.abs(c.amountCents) >= fullCents * FULL_PRICE_TOLERANCE,
    );
    const firstFull = atFullPrice[0];
    if (!firstFull) continue;

    const gapDays =
      (firstFull.postedAt.getTime() - intro.postedAt.getTime()) / DAY;
    if (gapDays < MIN_CONVERSION_DAYS) continue;
    if (gapDays > periodDays * MAX_CONVERSION_PERIODS) continue;
    if ((now - firstFull.postedAt.getTime()) / DAY > LOOKBACK_DAYS) continue;

    out.push({
      seriesId: s.id,
      name: titleCase(s.payeeNormalized),
      cadence,
      introAmountCents: introCents,
      introChargedAt: intro.postedAt,
      fullAmountCents: fullCents,
      endedAt: firstFull.postedAt,
      fullCharges: atFullPrice.length,
      confidence: atFullPrice.length >= 2 ? "high" : "medium",
      nextExpectedAt: s.nextExpectedAt,
    });
  }

  // Most recent conversion first — that's the one still worth acting on.
  return out.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
}
