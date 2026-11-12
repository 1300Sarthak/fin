import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ledgerChanges, transactions } from "@/db/schema";

/**
 * A sync can restate a purchase's amount after it was split (pending to posted,
 * a tip). The user's share is the fact they stated, so keep it fixed and let the
 * reimbursed portion absorb the difference: row = max(new total - share, 0).
 * Kept free of server-only imports because the sync scripts run without them.
 */
export async function keepSplitShares(accountId: number): Promise<number> {
  const rows = await db.select({ rowId: transactions.id, rowAmount: transactions.amountCents, purchaseId: transactions.refundsTxnId })
    .from(transactions).where(and(eq(transactions.accountId, accountId), eq(transactions.source, "split")));
  let fixed = 0;
  for (const r of rows) {
    if (r.purchaseId == null) continue;
    const purchase = await db.select({ amountCents: transactions.amountCents }).from(transactions).where(eq(transactions.id, r.purchaseId)).get();
    const change = await db.select().from(ledgerChanges)
      .where(and(eq(ledgerChanges.txnId, r.purchaseId), eq(ledgerChanges.kind, "split"), eq(ledgerChanges.status, "applied"))).orderBy(desc(ledgerChanges.id)).get();
    if (!purchase || purchase.amountCents >= 0 || !change) continue;
    const after = JSON.parse(change.afterJson) as { shareCents: number; totalCents: number; reimbursedCents: number };
    const total = -purchase.amountCents;
    const wanted = Math.max(total - after.shareCents, 0);
    if (wanted === r.rowAmount && total === after.totalCents) continue;
    await db.update(transactions).set({ amountCents: wanted }).where(eq(transactions.id, r.rowId));
    await db.update(ledgerChanges).set({ afterJson: JSON.stringify({ ...after, totalCents: total, reimbursedCents: wanted }) }).where(eq(ledgerChanges.id, change.id));
    fixed++;
  }
  return fixed;
}
