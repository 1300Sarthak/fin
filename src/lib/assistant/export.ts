import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, transactions } from "@/db/schema";
import { createExportWorkbook } from "@/lib/export-core";
import { isoDate } from "@/lib/format";
import { getSpendingByCategory, monthRange } from "@/lib/spending";
import { listChanges } from "./changes";
import { isCashSweep, isInvestmentAccountType } from "@/lib/cashflow-scope";

const dollars = (cents: number) => cents / 100;

/**
 * One month as a workbook: every ledger row with what it contributes after
 * splits and reimbursements, the category totals exactly as the Spending page
 * computes them, and the audit log of assistant edits touching the month.
 */
export async function buildMonthWorkbook(month: string): Promise<Buffer> {
  const r = monthRange(month);
  const [rows, linked, byCategory, changes] = await Promise.all([
    db.select({
      id: transactions.id, postedAt: transactions.postedAt, merchant: transactions.merchantRaw, account: accounts.name, accountType: accounts.type,
      category: categories.name, kind: sql<string>`COALESCE(${categories.kind}, 'expense')`, amountCents: transactions.amountCents,
      isRefund: transactions.isRefund, refundsTxnId: transactions.refundsTxnId, isExcluded: transactions.isExcluded,
      isTransfer: transactions.isTransfer, source: transactions.source, note: transactions.note,
    }).from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(gte(transactions.postedAt, r.start), lte(transactions.postedAt, r.end))).orderBy(asc(transactions.postedAt), asc(transactions.id)),
    // Same attribution as the Spending page: money linked back to a purchase, whatever month it landed in.
    db.select({ id: transactions.refundsTxnId, cents: sql<number>`SUM(${transactions.amountCents})`, split: sql<number>`SUM(CASE WHEN ${transactions.source} = 'split' THEN ${transactions.amountCents} ELSE 0 END)` })
      .from(transactions).where(and(eq(transactions.isRefund, true), eq(transactions.isExcluded, false), eq(transactions.isTransfer, false), sql`${transactions.amountCents} > 0`, sql`${transactions.refundsTxnId} IS NOT NULL`))
      .groupBy(transactions.refundsTxnId),
    getSpendingByCategory(r),
    listChanges(month),
  ]);
  const paidBack = new Map(linked.map((x) => [x.id, x]));

  const ledger = rows.map((x) => {
    const back = paidBack.get(x.id);
    const counts = !x.isExcluded && !x.isTransfer && !isInvestmentAccountType(x.accountType) && !isCashSweep({ merchantRaw: x.merchant, accountType: x.accountType, accountName: x.account }) && x.kind !== "transfer" && x.kind !== "investment";
    const isExpense = x.amountCents < 0 && x.kind !== "income";
    // What the row adds to cash flow once splits, reimbursements and exclusions are applied.
    const counted = !counts ? 0
      : x.amountCents < 0 ? (isExpense ? -Math.max(-x.amountCents - (back?.cents ?? 0), 0) : 0)
      : x.isRefund ? (x.refundsTxnId == null ? x.amountCents : 0)
      : x.amountCents;
    return {
      date: isoDate(x.postedAt), merchant: x.merchant, account: x.account, category: x.category ?? "Uncategorized",
      amount_usd: dollars(x.amountCents), my_share_usd: dollars(counted),
      split: x.source === "split" ? "Reimbursed portion" : back?.split ? `Your share ${(Math.max(-x.amountCents - back.split, 0) / 100).toFixed(2)} of ${(-x.amountCents / 100).toFixed(2)}` : "",
      refund: x.isRefund ? (x.source === "split" ? "Split" : "Yes") : "", excluded: x.isExcluded ? "Yes" : "", note: x.note ?? "",
    };
  });

  return createExportWorkbook([
    { name: "Transactions", columns: ["date", "merchant", "account", "category", "amount_usd", "my_share_usd", "split", "refund", "excluded", "note"], rows: ledger },
    { name: "By category", columns: ["category", "spent_usd", "refunded_usd", "purchases"], rows: [
      ...byCategory.map((x) => ({ category: x.name, spent_usd: dollars(x.spentCents), refunded_usd: dollars(x.refundedCents), purchases: x.count })),
      { category: "Total", spent_usd: dollars(byCategory.reduce((s, x) => s + x.spentCents, 0)), refunded_usd: dollars(byCategory.reduce((s, x) => s + x.refundedCents, 0)), purchases: byCategory.reduce((s, x) => s + x.count, 0) },
    ] },
    { name: "Changes", columns: ["id", "created", "status", "kind", "summary", "date", "merchant", "amount_usd", "applied", "undone"], rows: changes.map((c) => ({
      id: c.id, created: c.createdAt, status: c.status, kind: c.kind, summary: c.summary, date: c.txn.date, merchant: c.txn.merchant,
      amount_usd: dollars(c.txn.amountCents), applied: c.appliedAt ?? "", undone: c.undoneAt ?? "",
    })) },
  ]);
}
