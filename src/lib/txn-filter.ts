import { db } from "@/db";
import { categories, incomeEntries, incomeSources, transactions } from "@/db/schema";
import { and, eq, gt, gte, inArray, isNull, like, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { endOfDay, parseISO, startOfDay } from "date-fns";
import { getCashAccount } from "@/lib/cash";
import { incomeRowSql, netSpentSql, spendingRowSql } from "@/lib/spending";

export * from "@/lib/txn-filter-core";
import type { TxnFilter } from "@/lib/txn-filter-core";

const NO_CATEGORY = new Set(["uncategorized", "none"]);
const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const contains = (col: Parameters<typeof like>[0], text: string) => sql`${col} like ${likeEscape(text)} escape '\\'`;

/** Builds the WHERE for a filter. Unknown category or source names match nothing, never everything. */
export async function txnWhere(f: TxnFilter): Promise<SQL | undefined> {
  const w: (SQL | undefined)[] = [];
  if (f.from) w.push(gte(transactions.postedAt, startOfDay(parseISO(f.from))));
  if (f.to) w.push(lte(transactions.postedAt, endOfDay(parseISO(f.to))));
  if (f.id) w.push(eq(transactions.id, f.id));
  if (f.account) w.push(eq(transactions.accountId, f.account));
  // Cash spending and income count in cash flow, so their lists keep the cash wallet.
  else if (f.kind !== "expense" && f.kind !== "income" && f.kind !== "cashflow") {
    const cash = await getCashAccount();
    if (cash) w.push(ne(transactions.accountId, cash.id));
  }
  if (f.category) {
    if (NO_CATEGORY.has(f.category.toLowerCase())) w.push(isNull(transactions.categoryId));
    else {
      const all = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories);
      const hit = all.filter((c) => c.name.toLowerCase() === f.category!.toLowerCase()).map((c) => c.id);
      const ids = [...hit, ...all.filter((c) => c.parentId != null && hit.includes(c.parentId)).map((c) => c.id)];
      w.push(ids.length ? inArray(transactions.categoryId, ids) : sql`1 = 0`);
    }
  }
  if (f.merchant) w.push(or(contains(transactions.merchantRaw, f.merchant), contains(transactions.payeeNormalized, f.merchant)));
  if (f.q) w.push(or(contains(transactions.merchantRaw, f.q), contains(transactions.memo, f.q), contains(transactions.note, f.q)));
  // The exact rows behind Spent and Made (see getCashflow), not a looser sign test.
  if (f.kind === "income") w.push(incomeRowSql());
  else if (f.kind === "expense") w.push(spendingRowSql());
  else if (f.kind === "cashflow") w.push(or(incomeRowSql(), spendingRowSql()));
  else if (f.kind === "transfer") w.push(eq(transactions.isTransfer, true));
  if (f.source) {
    const [src] = await db.select().from(incomeSources).where(sql`lower(${incomeSources.name}) = ${f.source.toLowerCase()}`);
    if (!src) w.push(sql`1 = 0`);
    else {
      const linked = (await db.select({ id: incomeEntries.txnId }).from(incomeEntries).where(eq(incomeEntries.sourceId, src.id)))
        .map((r) => r.id).filter((id): id is number => id != null);
      const byPattern = src.matchPattern ? and(gt(transactions.amountCents, 0), contains(transactions.merchantRaw, src.matchPattern)) : undefined;
      const byLink = linked.length ? inArray(transactions.id, linked) : undefined;
      w.push(byPattern || byLink ? or(byPattern, byLink) : sql`1 = 0`);
    }
  }
  const parts = w.filter((x): x is SQL => x != null);
  return parts.length ? and(...parts) : undefined;
}

/** A category's name by id, for callers (the CLI) that still pass ids. */
export async function getCategoryName(id: number): Promise<string> {
  const [row] = await db.select({ name: categories.name }).from(categories).where(eq(categories.id, id));
  if (!row) throw new Error(`no category with id ${id}`);
  return row.name;
}

export type TxnTotals = { count: number; inCents: number; outCents: number; netCents: number; countedRows: number };

/**
 * Rows plus totals for the whole filtered set (not just the page shown).
 * Totals follow cash flow: transfers and never-count rows are listed but not
 * summed, unless the filter asks for transfers.
 */
export async function getFilteredTransactions(f: TxnFilter, { limit = 200, offset = 0 } = {}) {
  const where = await txnWhere(f);
  const counted = f.kind === "transfer" ? where : and(where, eq(transactions.isTransfer, false), eq(transactions.isExcluded, false));
  // Spent nets refunds the way getCashflow does: a linked refund comes off its
  // purchase, an unlinked one off the total. So money out is net spend here,
  // and for cashflow money in is Made alone (an unlinked refund is netted out).
  const spent = f.kind === "expense" || f.kind === "cashflow";
  const out = spent
    ? netSpentSql()
    : sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`;
  const into = f.kind === "expense"
    ? sql<number>`0`
    : f.kind === "cashflow"
      ? sql<number>`coalesce(sum(case when ${incomeRowSql()} then ${transactions.amountCents} else 0 end), 0)`
      : sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`;
  const [rows, [agg], [all]] = await Promise.all([
    db.query.transactions.findMany({
      where,
      with: { account: true, category: true, refundsTransaction: true, refundedBy: true },
      orderBy: (t, { desc }) => [desc(t.postedAt), desc(t.id)],
      limit,
      offset,
    }),
    db.select({
      n: sql<number>`count(*)`,
      inCents: into,
      outCents: out,
    }).from(transactions).where(counted),
    db.select({ n: sql<number>`count(*)` }).from(transactions).where(where),
  ]);
  const totals: TxnTotals = {
    count: Number(all.n),
    countedRows: Number(agg.n),
    inCents: Number(agg.inCents),
    outCents: Number(agg.outCents),
    netCents: Number(agg.inCents) - Number(agg.outCents),
  };
  return { rows, totals };
}

export type FilteredTxn = Awaited<ReturnType<typeof getFilteredTransactions>>["rows"][number];
