import { db } from "@/db";
import { transactions, categories, budgets, accounts } from "@/db/schema";
import { and, eq, gte, lte, sql, isNotNull, isNull, inArray, notInArray, lt, or } from "drizzle-orm";
import type { getTransactions } from "@/lib/queries";

// Money moving into these account types is investing, not spending.
const INVESTMENT_ACCOUNT_TYPES = ["brokerage", "ira", "crypto"] as const;
import {
  startOfMonth,
  endOfMonth,
  subMonths,
  parse,
  format,
} from "date-fns";

export type MonthRange = {
  start: Date;
  end: Date;
  key: string; // YYYY-MM
  label: string; // "June 2026"
};

export function monthRange(month?: string): MonthRange {
  const base = month
    ? parse(`${month}-01`, "yyyy-MM-dd", new Date())
    : new Date();
  return {
    start: startOfMonth(base),
    end: endOfMonth(base),
    key: format(base, "yyyy-MM"),
    label: format(base, "MMMM yyyy"),
  };
}

/**
 * The shared "what counts as spending this month" filter. Always excludes
 * transfers and investment-type accounts (brokerage/IRA/crypto) — buying assets
 * isn't spending. `accountIds`: undefined = all (non-investment) accounts, a
 * list = only those, an empty list = none.
 */
/** Activity that can affect cash flow. Category treatment is deliberately
 * separate: an Income category must still be eligible for the Made headline. */
const cashflowActivityInMonth = (r: MonthRange, accountIds?: number[]) =>
  and(
    gte(transactions.postedAt, r.start),
    lte(transactions.postedAt, r.end),
    eq(transactions.isTransfer, false),
    eq(transactions.isExcluded, false),
    notInArray(
      transactions.accountId,
      db
        .select({ id: accounts.id })
        .from(accounts)
        .where(inArray(accounts.type, [...INVESTMENT_ACCOUNT_TYPES])),
    ),
    ...(accountIds === undefined
      ? []
      : accountIds.length
        ? [inArray(transactions.accountId, accountIds)]
        : [sql`1 = 0`]),
  );

// An outflow filed as income, a transfer, or an investment is not spending.
// Keep uncategorized purchases eligible.
const isExpenseCategory = () =>
  or(
    isNull(transactions.categoryId),
    notInArray(
      transactions.categoryId,
      db.select({ id: categories.id }).from(categories)
        .where(inArray(categories.kind, ["income", "transfer", "investment"])),
    ),
  );

// Income categories are valid income. Only categories that explicitly describe
// internal movement or investing are excluded from the Made headline.
const isIncomeCategory = () =>
  or(
    isNull(transactions.categoryId),
    notInArray(
      transactions.categoryId,
      db.select({ id: categories.id }).from(categories)
        .where(inArray(categories.kind, ["transfer", "investment"])),
    ),
  );

// An unlinked refund reduces spending in the month it landed, even if its
// imported category is Income/Refund. Keep it in every spending view so the
// headline, category, card, and drill-down totals all reconcile.
const spendingActivityInMonth = (r: MonthRange, accountIds?: number[]) =>
  and(
    cashflowActivityInMonth(r, accountIds),
    or(isExpenseCategory(), and(eq(transactions.isRefund, true), isNull(transactions.refundsTxnId))),
  );

const inMonth = (r: MonthRange, accountIds?: number[]) =>
  and(cashflowActivityInMonth(r, accountIds), isExpenseCategory());

/**
 * Refunds linked to a given purchase (positive cents). Correlated on the outer
 * row, so it attributes a refund to the charge it reverses no matter which
 * month the refund actually landed in.
 */
const linkedRefundsSql = () => sql`(
      SELECT COALESCE(SUM(r.amountCents), 0) FROM ${transactions} r
      WHERE r.refundsTxnId = ${transactions.id}
        AND r.isRefund = 1
        AND r.isExcluded = 0
        AND r.isTransfer = 0
        AND r.amountCents > 0
    )`;

/**
 * Net spend. An outflow counts in full minus anything refunded back against it,
 * so a July purchase refunded in August stops counting as July spending. A
 * refund we could not link to a specific charge falls back to reducing the
 * month it landed in. A LINKED refund contributes nothing on its own — it has
 * already been subtracted from its purchase, and counting it twice would push
 * spending negative.
 */
const netSpentSql = () => sql<number>`COALESCE(SUM(CASE
    WHEN ${transactions.amountCents} < 0 AND ${isExpenseCategory()}
      THEN MAX(-${transactions.amountCents} - ${linkedRefundsSql()}, 0)
    WHEN ${transactions.isRefund} = 1 AND ${transactions.refundsTxnId} IS NULL
      THEN -${transactions.amountCents}
    ELSE 0 END), 0)`;

/** Refund dollars given back (positive), attributed the same way as above. */
const refundedSql = () => sql<number>`COALESCE(SUM(CASE
    WHEN ${transactions.amountCents} < 0 AND ${isExpenseCategory()} THEN ${linkedRefundsSql()}
    WHEN ${transactions.isRefund} = 1 AND ${transactions.refundsTxnId} IS NULL
      THEN ${transactions.amountCents}
    ELSE 0 END), 0)`;

/** Outflow count only — a refund isn't another purchase. */
const purchaseCountSql = () =>
  sql<number>`SUM(CASE WHEN ${transactions.amountCents} < 0 AND ${isExpenseCategory()} THEN 1 ELSE 0 END)`;

export type Cashflow = {
  incomeCents: number;
  spendingCents: number;
  refundCents: number;
  net: number;
};

export async function getCashflow(
  r: MonthRange,
  accountIds?: number[],
): Promise<Cashflow> {
  const row = await db
    .select({
      // Refunds are excluded from income — they're netted out of spending instead.
      income: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 AND ${transactions.isRefund} = 0 AND ${isIncomeCategory()} THEN ${transactions.amountCents} ELSE 0 END), 0)`,
      spending: netSpentSql(),
      refunded: refundedSql(),
    })
    .from(transactions)
    .where(cashflowActivityInMonth(r, accountIds))
    .get();
  const incomeCents = row?.income ?? 0;
  const spendingCents = row?.spending ?? 0;
  const refundCents = row?.refunded ?? 0;
  return { incomeCents, spendingCents, refundCents, net: incomeCents - spendingCents };
}

export type CategorySpend = {
  categoryId: number | null;
  name: string;
  /** Net of refunds — what was actually spent. */
  spentCents: number;
  /** Refunded back within this category (positive), for display. */
  refundedCents: number;
  count: number;
  pct: number;
};

export async function getSpendingByCategory(
  r: MonthRange,
  accountIds?: number[],
): Promise<CategorySpend[]> {
  const rows = await db
    .select({
      categoryId: transactions.categoryId,
      name: sql<string>`COALESCE(${categories.name}, 'Uncategorized')`,
      kind: sql<string>`COALESCE(${categories.kind}, 'expense')`,
      unlinkedRefund: sql<number>`SUM(CASE WHEN ${transactions.isRefund} = 1 AND ${transactions.refundsTxnId} IS NULL THEN 1 ELSE 0 END)`,
      spent: netSpentSql(),
      refunded: refundedSql(),
      count: purchaseCountSql(),
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(spendingActivityInMonth(r, accountIds))
    .groupBy(transactions.categoryId);

  const expenses = rows
    .filter(
      (x) =>
        // Keep a net-refund category visible too: omitting it would make the
        // category breakdown disagree with the cash-flow headline.
        x.spent !== 0 &&
        (x.kind !== "income" || x.unlinkedRefund > 0) &&
        x.kind !== "transfer" &&
        x.kind !== "investment",
    )
    .map((x) => ({
      categoryId: x.categoryId,
      name: x.name,
      spentCents: x.spent,
      refundedCents: x.refunded,
      count: x.count,
    }))
    .sort((a, b) => b.spentCents - a.spentCents);

  const total = expenses.reduce((s, x) => s + x.spentCents, 0) || 1;
  return expenses.map((x) => ({ ...x, pct: x.spentCents / total }));
}

export type AccountSpend = {
  accountId: number;
  name: string;
  /** Net of refunds. */
  spentCents: number;
  refundedCents: number;
  count: number;
};

export type SpendingTransaction = Awaited<ReturnType<typeof getTransactions>>[number] & {
  /** Amount that contributes to spending after linked refunds. Can be negative for an unlinked refund. */
  netSpentCents: number;
  /** Linked money returned against this purchase. */
  refundedCents: number;
};

/**
 * The inspectable transaction population for the spending page. It shares the
 * same eligibility filter and refund treatment as the headline and breakdown
 * queries, so the detail list's Net spend total always reconciles.
 */
export async function getSpendingTransactions(
  r: MonthRange,
  accountIds?: number[],
): Promise<SpendingTransaction[]> {
  const rows = await db.query.transactions.findMany({
    where: and(
      spendingActivityInMonth(r, accountIds),
      or(
        lt(transactions.amountCents, 0),
        and(
          eq(transactions.isRefund, true),
          isNull(transactions.refundsTxnId),
        ),
      ),
    ),
    with: {
      account: true,
      category: true,
      refundsTransaction: true,
      refundedBy: true,
    },
    orderBy: (t, { desc }) => [desc(t.postedAt)],
  });

  return rows.map((transaction) => {
    const refundedCents = transaction.refundedBy.reduce(
      (sum, refund) =>
        refund.isRefund && !refund.isExcluded && !refund.isTransfer && refund.amountCents > 0
          ? sum + refund.amountCents
          : sum,
      0,
    );
    return {
      ...transaction,
      refundedCents,
      netSpentCents:
        transaction.amountCents < 0
          ? Math.max(-transaction.amountCents - refundedCents, 0)
          : -transaction.amountCents,
    };
  });
}

/** Spending grouped by the account/card it came from (transfers excluded). */
export async function getSpendingByAccount(
  r: MonthRange,
  accountIds?: number[],
): Promise<AccountSpend[]> {
  const rows = await db
    .select({
      accountId: transactions.accountId,
      name: accounts.name,
      spent: netSpentSql(),
      refunded: refundedSql(),
      count: purchaseCountSql(),
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(spendingActivityInMonth(r, accountIds))
    .groupBy(transactions.accountId);

  return rows
    // A card can also have a net refund for the month; retain it so the card
    // total reconciles with cash flow instead of silently hiding a credit.
    .filter((x) => x.spent !== 0)
    .map((x) => ({
      accountId: x.accountId,
      name: x.name,
      spentCents: x.spent,
      refundedCents: x.refunded,
      count: x.count,
    }))
    .sort((a, b) => b.spentCents - a.spentCents);
}

export type TrendPoint = { month: string; income: number; expense: number };

export async function getMonthlyTrend(
  months = 6,
  accountId?: number,
): Promise<TrendPoint[]> {
  // Use the exact headline calculation for every bucket. This keeps category,
  // account, transfer, exclusion, and cross-month refund rules consistent.
  const now = new Date();
  const ranges = Array.from({ length: months }, (_, index) =>
    monthRange(format(subMonths(now, months - index - 1), "yyyy-MM")),
  );
  const rows = await Promise.all(
    ranges.map((range) => getCashflow(range, accountId ? [accountId] : undefined)),
  );
  return ranges.map((range, index) => ({
    month: range.key,
    income: rows[index].incomeCents,
    expense: rows[index].spendingCents,
  }));
}

export type TopMerchant = { merchant: string; spentCents: number; count: number };

export async function getTopMerchants(
  r: MonthRange,
  limit = 8,
  accountIds?: number[],
): Promise<TopMerchant[]> {
  const rows = await db
    .select({
      merchant: transactions.merchantRaw,
      spent: netSpentSql(),
      count: sql<number>`COUNT(*)`,
    })
    .from(transactions)
    .where(inMonth(r, accountIds))
    .groupBy(transactions.merchantRaw)
    .orderBy(sql`${netSpentSql()} DESC`)
    .limit(limit);
  return rows
    .filter((x) => x.spent > 0)
    .map((x) => ({ merchant: x.merchant, spentCents: x.spent, count: x.count }));
}

export type BudgetRow = {
  id: number;
  categoryId: number;
  name: string;
  limitCents: number;
  spentCents: number;
  pct: number;
};

export async function getBudgetsWithActual(
  r: MonthRange,
  accountIds?: number[],
): Promise<BudgetRow[]> {
  const buds = await db
    .select({
      id: budgets.id,
      categoryId: budgets.categoryId,
      name: categories.name,
      limitCents: budgets.limitCents,
    })
    .from(budgets)
    .innerJoin(categories, eq(budgets.categoryId, categories.id));

  const spendRows = await db
    .select({
      categoryId: transactions.categoryId,
      spent: netSpentSql(),
    })
    .from(transactions)
    .where(and(inMonth(r, accountIds), isNotNull(transactions.categoryId)))
    .groupBy(transactions.categoryId);
  const spentByCat = new Map(spendRows.map((x) => [x.categoryId, x.spent]));

  return buds
    .map((b) => {
      const spentCents = spentByCat.get(b.categoryId) ?? 0;
      return {
        ...b,
        spentCents,
        pct: b.limitCents > 0 ? spentCents / b.limitCents : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}
