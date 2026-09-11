import { db } from "@/db";
import { accounts, transactions, categories } from "@/db/schema";
import { and, asc, eq, gt, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { getHideZeroAccounts } from "@/lib/config";
import { getCashAccount } from "@/lib/cash";

const INVESTMENT_ACCOUNT_TYPES = new Set(["brokerage", "ira", "crypto"]);

/**
 * Predicate for the "hide $0 accounts" setting.
 *
 * Balance alone cannot tell a dormant account from one in daily use: a card
 * reads $0 until its first charge posts and returns to $0 once the statement is
 * paid, so filtering on balance quietly hides accounts that are being used —
 * including a card that was just opened. An account is hidden only when it has
 * no balance AND no transactions at all.
 */
export async function getZeroAccountFilter(): Promise<
  (a: { id: number; bal: number }) => boolean
> {
  const hideZero = await getHideZeroAccounts();
  if (!hideZero) return () => true;
  const rows = await db
    .selectDistinct({ id: transactions.accountId })
    .from(transactions);
  const withActivity = new Set(rows.map((r) => r.id));
  return (a) => a.bal !== 0 || withActivity.has(a.id);
}

export type SelectCategory = { id: number; name: string; isChild: boolean };

/** Categories flattened parent-first for a grouped <select>. */
export async function getCategoriesForSelect(): Promise<SelectCategory[]> {
  const cats = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder));
  const tops = cats.filter((c) => c.parentId == null);
  const out: SelectCategory[] = [];
  for (const top of tops) {
    out.push({ id: top.id, name: top.name, isChild: false });
    for (const c of cats.filter((x) => x.parentId === top.id)) {
      out.push({ id: c.id, name: c.name, isChild: true });
    }
  }
  return out;
}

export async function getAccountsList(): Promise<{ id: number; name: string }[]> {
  const keep = await getZeroAccountFilter();
  const rows = await db
    .select({ id: accounts.id, name: accounts.name, bal: accounts.currentBalanceCents })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .orderBy(asc(accounts.name));
  return rows.filter(keep).map((r) => ({ id: r.id, name: r.name }));
}

/** Active accounts you actually spend from — excludes investment accounts
 *  (brokerage/IRA/crypto) and, when set, $0 accounts. Feeds the spending picker. */
export async function getSpendableAccounts(): Promise<{ id: number; name: string }[]> {
  const keep = await getZeroAccountFilter();
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      bal: accounts.currentBalanceCents,
      type: accounts.type,
    })
    .from(accounts)
    .where(eq(accounts.isActive, true))
    .orderBy(asc(accounts.name));
  return rows
    .filter((r) => !INVESTMENT_ACCOUNT_TYPES.has(r.type) && keep(r))
    .map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Accounts for display. Closed accounts are `isActive: false` and already sit
 * outside every total (see `getAccountTotals`), so they are hidden here too —
 * otherwise a closed account keeps appearing in listings that no longer count
 * it. Pass `includeInactive` from the accounts settings page, which needs them
 * visible to offer the toggle back on.
 */
export async function getAccountsWithInstitution(
  { includeInactive = false }: { includeInactive?: boolean } = {},
) {
  const keep = await getZeroAccountFilter();
  const rows = await db.query.accounts.findMany({
    with: { institution: true },
    orderBy: (a, { desc }) => [desc(a.isAsset), desc(a.currentBalanceCents)],
  });
  return rows
    .filter((a) => includeInactive || a.isActive)
    .filter((a) => keep({ id: a.id, bal: a.currentBalanceCents }));
}

export type AccountTotals = {
  assets: number;
  liabilities: number;
  net: number;
};

/**
 * Sum active accounts into assets/liabilities/net. Pass `includeAccountIds` to
 * restrict the total to a subset (empty array = none → all zero); omit it for
 * all active accounts (unchanged default for existing callers).
 */
export async function getAccountTotals(
  includeAccountIds?: number[],
): Promise<AccountTotals> {
  if (includeAccountIds && includeAccountIds.length === 0) {
    return { assets: 0, liabilities: 0, net: 0 };
  }
  const where = includeAccountIds
    ? and(eq(accounts.isActive, true), inArray(accounts.id, includeAccountIds))
    : eq(accounts.isActive, true);

  const rows = await db
    .select({
      isAsset: accounts.isAsset,
      bal: accounts.currentBalanceCents,
    })
    .from(accounts)
    .where(where);

  let assets = 0;
  let liabilities = 0;
  for (const r of rows) {
    if (r.isAsset) assets += r.bal;
    else liabilities += r.bal;
  }
  return { assets, liabilities, net: assets - liabilities };
}

export async function getTransactions(opts: {
  q?: string;
  accountId?: number;
  accountIds?: number[];
  categoryId?: number | "none";
  since?: Date;
  until?: Date;
  isTransfer?: boolean;
  amountType?: "income" | "expense";
  limit?: number;
  offset?: number;
}) {
  const {
    q,
    accountId,
    accountIds,
    categoryId,
    since,
    until,
    isTransfer,
    amountType,
    limit = 50,
    offset = 0,
  } = opts;
  const filters = [];
  const cash = await getCashAccount();
  if (q) {
    filters.push(
      or(
        like(transactions.merchantRaw, `%${q}%`),
        like(transactions.memo, `%${q}%`),
      ),
    );
  }
  if (accountIds !== undefined) {
    filters.push(accountIds.length ? inArray(transactions.accountId, accountIds) : sql`1 = 0`);
  } else if (accountId) {
    filters.push(eq(transactions.accountId, accountId));
  } else if (cash) {
    filters.push(ne(transactions.accountId, cash.id));
  }
  if (categoryId === "none") filters.push(isNull(transactions.categoryId));
  else if (categoryId != null) filters.push(eq(transactions.categoryId, categoryId));
  if (since) filters.push(gte(transactions.postedAt, since));
  if (until) filters.push(lte(transactions.postedAt, until));
  if (typeof isTransfer === "boolean") filters.push(eq(transactions.isTransfer, isTransfer));
  if (amountType === "income") {
    filters.push(
      gt(transactions.amountCents, 0),
      eq(transactions.isTransfer, false),
      eq(transactions.isExcluded, false),
    );
  } else if (amountType === "expense") {
    filters.push(
      sql`${transactions.amountCents} < 0`,
      eq(transactions.isTransfer, false),
      eq(transactions.isExcluded, false),
    );
  }

  return db.query.transactions.findMany({
    where: filters.length ? and(...filters) : undefined,
    with: {
      account: true,
      category: true,
      // Lets a refund row name the charge it reverses, and lets a purchase show
      // that it was refunded, without a second round trip.
      refundsTransaction: true,
      refundedBy: true,
    },
    orderBy: (t, { desc }) => [desc(t.postedAt)],
    limit,
    offset,
  });
}

export async function countTransactions(opts?: { amountType?: "income" | "expense" }): Promise<number> {
  const cash = await getCashAccount();
  return db.$count(
    transactions,
    and(
      cash ? ne(transactions.accountId, cash.id) : undefined,
      opts?.amountType === "income" ? gt(transactions.amountCents, 0) : undefined,
      opts?.amountType === "income" ? eq(transactions.isTransfer, false) : undefined,
      opts?.amountType === "income" ? eq(transactions.isExcluded, false) : undefined,
      opts?.amountType === "expense" ? sql`${transactions.amountCents} < 0` : undefined,
      opts?.amountType === "expense" ? eq(transactions.isTransfer, false) : undefined,
      opts?.amountType === "expense" ? eq(transactions.isExcluded, false) : undefined,
    ),
  );
}

export async function countUncategorized(): Promise<number> {
  const cash = await getCashAccount();
  return db.$count(
    transactions,
    and(
      isNull(transactions.categoryId),
      eq(transactions.isTransfer, false),
      eq(transactions.isExcluded, false),
      cash ? ne(transactions.accountId, cash.id) : undefined,
    ),
  );
}
