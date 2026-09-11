/**
 * Direct row edits an operator (or an agent driving the CLI) needs to correct
 * the ledger: excluding a row from analytics, and spotting a pending
 * authorisation that has already settled under a second row.
 *
 * The categorisation equivalent already lives in `categorize.ts` as
 * `setManualCategory`, which also writes a rule and cache entry so the fix
 * sticks for that merchant.
 */
import { db } from "@/db";
import { transactions, accounts } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * Keep a ledger entry visible while removing it from every cash-flow metric.
 * A transfer is already outside cash flow, so excluding one would double up on
 * a decision the ledger has recorded elsewhere — restore it first instead.
 */
export async function setExcluded(id: number, isExcluded: boolean): Promise<void> {
  const existing = await db
    .select({ id: transactions.id, isTransfer: transactions.isTransfer })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!existing) throw new Error(`no transaction #${id}`);
  if (isExcluded && existing.isTransfer) {
    throw new Error(`#${id} is a transfer and is already outside cash flow — unmark the transfer first`);
  }
  await db.update(transactions).set({ isExcluded }).where(eq(transactions.id, id));
}

export type PendingDuplicate = {
  pendingId: number;
  pendingDate: string;
  postedId: number;
  postedDate: string;
  amountCents: number;
  merchant: string;
  account: string;
};

/** How far apart a pending hold and its settled row may sit. */
export const SETTLE_WINDOW_DAYS = 5;

/**
 * A card authorisation and its settlement arrive as two rows when the provider
 * mints a fresh id on settlement. Both carry live ids, so the reissue repair in
 * `scripts/dedupe-reissued-transactions.ts` deliberately leaves them alone —
 * it cannot tell them from two genuinely identical charges. The pending flag
 * can: a still-pending row whose exact amount has already posted nearby on the
 * same account is a hold that was never cleared, and it inflates the month.
 */
export async function findPendingDuplicates(): Promise<PendingDuplicate[]> {
  const posted = db.$with("posted").as(
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amountCents: transactions.amountCents,
        postedAt: transactions.postedAt,
      })
      .from(transactions)
      .where(and(eq(transactions.isPending, false), eq(transactions.isExcluded, false))),
  );

  const rows = await db
    .with(posted)
    .select({
      pendingId: transactions.id,
      pendingAt: transactions.postedAt,
      postedId: posted.id,
      postedAt: posted.postedAt,
      amountCents: transactions.amountCents,
      merchant: transactions.merchantRaw,
      account: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(
      posted,
      and(
        eq(posted.accountId, transactions.accountId),
        eq(posted.amountCents, transactions.amountCents),
        sql`abs(${posted.postedAt} - ${transactions.postedAt}) <= ${SETTLE_WINDOW_DAYS * 86_400}`,
      ),
    )
    .where(and(eq(transactions.isPending, true), eq(transactions.isExcluded, false)));

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return rows.map((r) => ({
    pendingId: r.pendingId,
    pendingDate: iso(r.pendingAt),
    postedId: r.postedId,
    postedDate: iso(r.postedAt),
    amountCents: r.amountCents,
    merchant: r.merchant,
    account: r.account,
  }));
}

/** Every pending row, settled twin or not — they all inflate the current month. */
export async function listPending(since: Date) {
  return db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      amountCents: transactions.amountCents,
      merchant: transactions.merchantRaw,
      account: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.isPending, true), eq(transactions.isExcluded, false), gte(transactions.postedAt, since)))
    .orderBy(transactions.postedAt);
}
