import { db } from "@/db";
import { accounts, transactions } from "@/db/schema";
import { and, eq, inArray, isNull, lte, gte, ne, or } from "drizzle-orm";
import { chunk } from "@/lib/normalize";

const PAYMENT_RE =
  /\b(payment|autopay|auto pay|online payment|thank you|pymt|bill ?pay|e-?payment|ach|web ?pymt|card ?payment|epay)\b/i;

const MATCH_WINDOW_MS = 4 * 86400 * 1000; // pair tolerance: ±4 days

type TransferRow = {
  id: number;
  accountId: number;
  amountCents: number;
  postedAt: Date;
  merchantRaw: string;
};

type TransferStateRow = TransferRow & {
  isTransfer: boolean;
  transferPairTxnId: number | null;
  isRefund: boolean;
  isExcluded: boolean;
};

/** Only repair historical automatic rows; recorded manual pairs are durable. */
export function orphanTransferIdsToRestore(
  rows: TransferStateRow[],
  validAutoTransferIds: ReadonlySet<number>,
): number[] {
  return rows
    .filter((t) => t.isTransfer && t.transferPairTxnId == null && !validAutoTransferIds.has(t.id))
    .map((t) => t.id);
}

/** A manual match can only use a currently-unclassified, unpaired ledger row. */
export function isAvailableManualTransferCounterpart(
  txn: Pick<TransferStateRow, "isRefund" | "isExcluded" | "isTransfer" | "transferPairTxnId">,
): boolean {
  return !txn.isRefund && !txn.isExcluded && !txn.isTransfer && txn.transferPairTxnId == null;
}

/** A payment-looking credit or loan deposit is safe to classify on its own. */
export function isHighConfidenceTransferPayment(
  txn: TransferRow,
  typeById: Map<number, string>,
): boolean {
  const type = typeById.get(txn.accountId);
  return (
    (type === "credit" || type === "loan") &&
    txn.amountCents > 0 &&
    PAYMENT_RE.test(txn.merchantRaw)
  );
}

/**
 * Exact dollar amounts alone are not evidence of a transfer: subscription
 * charges and card fees routinely coincide with unrelated credits.  Automatic
 * pairing is intentionally limited to a payment-looking row on a liability
 * account.  Users can still explicitly pair an unambiguous ledger entry.
 */
export function isHighConfidenceTransferPair(
  debit: TransferRow,
  credit: TransferRow,
  typeById: Map<number, string>,
): boolean {
  if (
    debit.accountId === credit.accountId ||
    debit.amountCents >= 0 ||
    credit.amountCents !== -debit.amountCents ||
    Math.abs(debit.postedAt.getTime() - credit.postedAt.getTime()) > MATCH_WINDOW_MS
  ) return false;

  return [debit, credit].some((t) => isHighConfidenceTransferPayment(t, typeById));
}

/**
 * Mark internal money movement as transfers so it isn't double-counted as
 * income/spending. Two passes:
 *  1. Payments posted to a liability (credit/loan) account that look like a
 *     card payment ("PAYMENT", "AUTOPAY", "THANK YOU", …).
 *  2. Matched cross-account pairs — a debit in one account and a credit of the
 *     same size in another within a few days (e.g. checking → credit card).
 * Idempotent: only flips transactions that aren't already transfers.
 */
export async function detectTransfers(): Promise<{ marked: number }> {
  const accs = await db.select().from(accounts);
  const typeById = new Map(accs.map((a) => [a.id, a.type]));

  const txns = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      postedAt: transactions.postedAt,
      merchantRaw: transactions.merchantRaw,
      isTransfer: transactions.isTransfer,
      transferPairTxnId: transactions.transferPairTxnId,
      isRefund: transactions.isRefund,
      isExcluded: transactions.isExcluded,
    })
    .from(transactions);

  const toMark = new Set<number>();

  // Pass 1 — payments to credit/loan accounts.
  for (const t of txns) {
    if (t.isRefund || t.isExcluded) continue;
    if (isHighConfidenceTransferPayment(t, typeById)) {
      toMark.add(t.id);
    }
  }

  // Pass 2 — only high-confidence debit/credit pairs across accounts. Do not
  // auto-pair arbitrary equal-and-opposite rows (e.g. a LinkedIn charge and a
  // same-day bank fee/refund): amount + date by itself is too weak.
  const positivesByMag = new Map<number, typeof txns>();
  for (const t of txns) {
    if (t.amountCents <= 0) continue;
    const k = t.amountCents;
    const list = positivesByMag.get(k) ?? [];
    list.push(t);
    positivesByMag.set(k, list);
  }
  const usedPos = new Set<number>();
  for (const n of txns) {
    if (n.amountCents >= 0 || n.isRefund || n.isExcluded) continue;
    const cands = positivesByMag.get(-n.amountCents);
    if (!cands) continue;
    const match = cands.find(
      (p) => !usedPos.has(p.id) && !p.isRefund && !p.isExcluded && isHighConfidenceTransferPair(n, p, typeById),
    );
    if (match) {
      usedPos.add(match.id);
      toMark.add(n.id);
      toMark.add(match.id);
    }
  }

  // Older releases recorded automatic transfers without a pair id. Recover
  // only those orphaned classifications that no longer have either accepted
  // automatic signal. This restores false positives such as unrelated fees
  // and subscriptions while retaining real card-payment records.
  const validAutoTransferIds = toMark;
  const staleOrphanIds = orphanTransferIdsToRestore(txns, validAutoTransferIds);
  if (staleOrphanIds.length > 0) {
    for (const batch of chunk(staleOrphanIds, 200)) {
      await db.update(transactions).set({ isTransfer: false }).where(inArray(transactions.id, batch));
    }
  }

  const already = new Map(txns.map((t) => [t.id, t.isTransfer]));
  const ids = [...toMark].filter((id) => already.get(id) === false);
  for (const batch of chunk(ids, 200)) {
    await db.update(transactions).set({ isTransfer: true }).where(inArray(transactions.id, batch));
  }
  return { marked: ids.length };
}

/**
 * Manually classify one ledger entry as an internal transfer. If the matching
 * opposite-side entry is present (same amount, another account, within four
 * days), mark it too. That makes a credit-card payoff disappear from both
 * sides of cash flow instead of treating the payment as a second expense.
 */
export async function markTransferWithMatch(id: number): Promise<{ matched: boolean }> {
  const txn = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      postedAt: transactions.postedAt,
      merchantRaw: transactions.merchantRaw,
      isRefund: transactions.isRefund,
      isExcluded: transactions.isExcluded,
      isTransfer: transactions.isTransfer,
      transferPairTxnId: transactions.transferPairTxnId,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!txn) throw new Error("Transaction not found");
  if (txn.isRefund || txn.isExcluded) {
    throw new Error("Refunds and excluded transactions cannot be transfers");
  }
  if (txn.isTransfer || txn.transferPairTxnId != null) {
    throw new Error("Transaction is already marked as a transfer");
  }

  const counterparts = await db
    .select({
      id: transactions.id,
      isRefund: transactions.isRefund,
      isExcluded: transactions.isExcluded,
      isTransfer: transactions.isTransfer,
      transferPairTxnId: transactions.transferPairTxnId,
    })
    .from(transactions)
    .where(
      and(
        ne(transactions.id, txn.id),
        ne(transactions.accountId, txn.accountId),
        eq(transactions.amountCents, -txn.amountCents),
        gte(transactions.postedAt, new Date(txn.postedAt.getTime() - MATCH_WINDOW_MS)),
        lte(transactions.postedAt, new Date(txn.postedAt.getTime() + MATCH_WINDOW_MS)),
        eq(transactions.isRefund, false),
        eq(transactions.isExcluded, false),
        eq(transactions.isTransfer, false),
        // Do not steal a row from a previously-recorded manual pair.
        // Keeping relationships intact makes both sides reliably reversible.
        isNull(transactions.transferPairTxnId),
      ),
    )
    .limit(3);

  // A manual click is still not permission to make an arbitrary pairing. If
  // multiple equal candidates exist, mark only the clicked row and let the
  // user choose a less ambiguous entry rather than corrupting cash flow.
  const availableCounterparts = counterparts.filter(isAvailableManualTransferCounterpart);
  const counterpart = availableCounterparts.length === 1 ? availableCounterparts[0] : undefined;
  if (counterpart) {
    await db.batch([
      db.update(transactions).set({ isTransfer: true, transferPairTxnId: counterpart.id }).where(eq(transactions.id, txn.id)),
      db.update(transactions).set({ isTransfer: true, transferPairTxnId: txn.id }).where(eq(transactions.id, counterpart.id)),
    ]);
  } else {
    await db.update(transactions).set({ isTransfer: true }).where(eq(transactions.id, txn.id));
  }
  return { matched: Boolean(counterpart) };
}

/** Undo a manual transfer decision, including its recorded counterpart. */
export async function unmarkTransferWithPair(id: number): Promise<{ matched: boolean }> {
  const txn = await db
    .select({ id: transactions.id, transferPairTxnId: transactions.transferPairTxnId })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!txn) throw new Error("Transaction not found");

  const ids = txn.transferPairTxnId ? [txn.id, txn.transferPairTxnId] : [txn.id];
  await db
    .update(transactions)
    .set({ isTransfer: false, transferPairTxnId: null })
    .where(or(inArray(transactions.id, ids), inArray(transactions.transferPairTxnId, ids)));
  return { matched: Boolean(txn.transferPairTxnId) };
}
