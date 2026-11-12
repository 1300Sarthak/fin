import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { and, desc, eq, sql, inArray, notInArray, ne } from "drizzle-orm";
import { refuseSplitRow } from "@/lib/ledger";
import { INVESTMENT_ACCOUNT_TYPES, cashSweepSql } from "@/lib/cashflow-scope";

/**
 * Refunds
 * -------
 * A refund is money-in that gives back an earlier purchase: a return, a price
 * adjustment, a reimbursement. It is NOT income — counting it as income leaves
 * spending overstated, because the original charge still counts in full.
 *
 * Two things make this work:
 *
 * 1. A flagged refund is netted out of spending (see `lib/spending.ts`) while
 *    staying visible in the ledger.
 *
 * 2. When we can tell WHICH purchase a refund reverses, `refundsTxnId` links
 *    them and the refund is attributed back to that purchase's month and
 *    category. This matters because refunds usually land in a later month than
 *    the charge: a $400 appliance bought in July and refunded in August must stop
 *    counting as JULY spending, otherwise July's pie chart still shows money
 *    that came back. Netting only in the refund's own month cannot fix that.
 *
 * Detection stays conservative — it must never turn genuine income (a paycheck,
 * interest, a marketplace payout) into "negative spending". It acts on three
 * signals, in descending confidence:
 *
 *   a. The transaction is filed under a refund-type category.
 *   b. It exactly reverses an earlier charge from the same payee.
 * Anything without an exact, eligible charge is left alone for the user to
 * decide by hand. A matching payee and expense category alone is useful
 * context in the UI, but it is not safe enough to change cash-flow history.
 */

// Money into investment-type accounts is investing, not spending — and never a
// refund. A money-market sweep is internal movement, so never a refund either.

/** How far back to look for the charge a refund is giving back. */
export const REFUND_MATCH_WINDOW_DAYS = 120;

export type RefundCandidate = {
  id: number;
  postedAt: Date;
  amountCents: number;
  merchantRaw: string;
  payeeNormalized: string;
  categoryName: string | null;
  accountName: string;
  /** Filed under a category that means "refund" — the strongest signal. */
  refundCategory: boolean;
  /** Id of an earlier charge this exactly reverses, when one exists. */
  reversesTxnId: number | null;
  /** Earlier charges from this payee inside the match window. */
  priorCharges: number;
  /** True when the signals are strong enough to auto-flag. */
  suggested: boolean;
};

/** Auto-classification requires an explicit refund category or an exact,
 * still-eligible reversal. Similar payees are display context only. */
export function shouldAutoDetectRefund(candidate: Pick<RefundCandidate, "refundCategory" | "reversesTxnId">): boolean {
  return candidate.refundCategory || candidate.reversesTxnId != null;
}

const investmentAccounts = db
  .select({ id: accounts.id })
  .from(accounts)
  .where(inArray(accounts.type, [...INVESTMENT_ACCOUNT_TYPES]));

/**
 * Every money-in row that could be a refund, with the signals behind it.
 *
 * Note there is deliberately NO filter on category kind here. An earlier
 * version skipped `kind = 'income'` rows, which silently excluded the whole
 * "Refunds" category — the single most obvious place refunds live — so real
 * returns were never detected. Genuine income is separated by the signals
 * below, not by the category's kind.
 */
export async function findRefundCandidates(): Promise<RefundCandidate[]> {
  const windowSeconds = REFUND_MATCH_WINDOW_DAYS * 86400;

  // The most recent earlier charge from the same payee for the exact amount.
  const reverses = sql<number | null>`(
    SELECT p.id FROM ${transactions} p
    WHERE p.payeeNormalized = ${transactions.payeeNormalized}
      AND p.accountId = ${transactions.accountId}
      AND p.amountCents = -${transactions.amountCents}
      AND p.postedAt < ${transactions.postedAt}
      AND p.postedAt > ${transactions.postedAt} - ${windowSeconds}
      AND p.isTransfer = 0
      AND p.isExcluded = 0
      AND p.isRefund = 0
      AND COALESCE((
        SELECT SUM(r.amountCents) FROM ${transactions} r
        WHERE r.refundsTxnId = p.id
          AND r.isRefund = 1
          AND r.isTransfer = 0
          AND r.isExcluded = 0
      ), 0) + ${transactions.amountCents} <= -p.amountCents
    ORDER BY p.postedAt DESC LIMIT 1
  )`;

  const prior = sql<number>`(
    SELECT COUNT(*) FROM ${transactions} p
    WHERE p.payeeNormalized = ${transactions.payeeNormalized}
      AND p.accountId = ${transactions.accountId}
      AND p.amountCents < 0
      AND p.postedAt < ${transactions.postedAt}
      AND p.postedAt > ${transactions.postedAt} - ${windowSeconds}
      AND p.isTransfer = 0
      AND p.isExcluded = 0
  )`;

  const rows = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      amountCents: transactions.amountCents,
      merchantRaw: transactions.merchantRaw,
      payeeNormalized: transactions.payeeNormalized,
      categoryName: categories.name,
      categoryKind: sql<string>`COALESCE(${categories.kind}, 'expense')`,
      accountName: accounts.name,
      reversesTxnId: reverses,
      priorCharges: prior,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        sql`${transactions.amountCents} > 0`,
        eq(transactions.isTransfer, false),
        eq(transactions.isExcluded, false),
        eq(transactions.isRefund, false),
        notInArray(transactions.accountId, investmentAccounts),
        sql`NOT ${cashSweepSql()}`,
      ),
    );

  return rows
    .map((r) => {
      const refundCategory = /refund/i.test(r.categoryName ?? "");
      return {
        id: r.id,
        postedAt: r.postedAt,
        amountCents: r.amountCents,
        merchantRaw: r.merchantRaw,
        payeeNormalized: r.payeeNormalized,
        categoryName: r.categoryName,
        accountName: r.accountName,
        refundCategory,
        reversesTxnId: r.reversesTxnId ?? null,
        priorCharges: r.priorCharges,
        suggested: shouldAutoDetectRefund({ refundCategory, reversesTxnId: r.reversesTxnId ?? null }),
      };
    })
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
}

/** Refunds the user has confirmed, with the original purchase when linked. */
export async function getRefunds() {
  return db.query.transactions.findMany({
    where: eq(transactions.isRefund, true),
    with: {
      account: true,
      refundsTransaction: {
        with: { account: true, category: true },
      },
    },
    orderBy: [desc(transactions.postedAt)],
  });
}

/** Flip one transaction's refund flag, optionally linking the purchase it reverses. */
export async function setRefund(
  id: number,
  isRefund: boolean,
  refundsTxnId?: number | null,
): Promise<void> {
  await refuseSplitRow(id);
  const refund = await db.select({
    id: transactions.id,
    accountId: transactions.accountId,
    amountCents: transactions.amountCents,
    postedAt: transactions.postedAt,
    isTransfer: transactions.isTransfer,
    isExcluded: transactions.isExcluded,
  }).from(transactions).where(eq(transactions.id, id)).get();
  if (!refund) throw new Error("Transaction not found");
  if (isRefund) {
    if (refund.amountCents <= 0) throw new Error("Only money-in transactions can be refunds");
    if (refund.isTransfer || refund.isExcluded) throw new Error("Transfers and excluded transactions cannot be refunds");
    const investment = await db.select({ id: accounts.id }).from(accounts).where(
      and(eq(accounts.id, refund.accountId), inArray(accounts.type, [...INVESTMENT_ACCOUNT_TYPES])),
    ).get();
    if (investment) throw new Error("Investment-account deposits cannot be refunds");
  }
  // A manual "this is a refund" click should be just as correct as the bulk
  // detector: when an exact earlier charge is available, attribute the money
  // back to that original purchase (and therefore its month, category, and
  // card). Callers can still explicitly supply a link or null.
  let linkedId = refundsTxnId;
  if (isRefund && refundsTxnId === undefined) {
    linkedId = (await findRefundCandidates()).find((candidate) => candidate.id === id)
      ?.reversesTxnId ?? null;
  }
  if (isRefund && linkedId != null) {
    const purchase = await db.select({
      id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents,
      postedAt: transactions.postedAt, isTransfer: transactions.isTransfer,
      isExcluded: transactions.isExcluded, isRefund: transactions.isRefund,
    }).from(transactions).where(eq(transactions.id, linkedId)).get();
    if (!purchase) throw new Error("Purchase to refund was not found");
    if (purchase.id === refund.id || purchase.accountId !== refund.accountId || purchase.amountCents >= 0 ||
      purchase.isTransfer || purchase.isExcluded || purchase.isRefund || purchase.postedAt >= refund.postedAt) {
      throw new Error("Refund must link to an earlier eligible purchase on the same account");
    }
    const existing = await db.select({ refunded: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)` })
      .from(transactions).where(and(
        eq(transactions.refundsTxnId, purchase.id), eq(transactions.isRefund, true),
        eq(transactions.isTransfer, false), eq(transactions.isExcluded, false), ne(transactions.id, refund.id),
      )).get();
    if ((existing?.refunded ?? 0) + refund.amountCents > -purchase.amountCents) {
      throw new Error("Refund total cannot exceed the original purchase");
    }
  }
  await db
    .update(transactions)
    .set({
      isRefund,
      // Clearing the flag must clear the link too, or spending would keep
      // subtracting the refund from the original purchase.
      refundsTxnId: isRefund ? (linkedId ?? null) : null,
    })
    .where(eq(transactions.id, id));
}

/**
 * Flag every candidate whose signals are strong enough, linking each to the
 * charge it reverses when that can be identified. Ambiguous money-in is left
 * alone so a tax refund or a gift is never reclassified as a refund.
 */
export async function autoDetectRefunds(): Promise<RefundCandidate[]> {
  const candidates = (await findRefundCandidates()).filter((c) => c.suggested);
  const matched: RefundCandidate[] = [];
  for (const c of candidates) {
    // Candidates are read as one snapshot. A second same-dollar refund can
    // make the first link consume the purchase's remaining capacity before we
    // reach it; leave that ambiguous row untouched rather than aborting the
    // entire detection pass or creating an over-refund.
    try {
      await setRefund(c.id, true, c.reversesTxnId);
      matched.push(c);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Refund total cannot exceed the original purchase") throw error;
    }
  }
  return matched;
}
