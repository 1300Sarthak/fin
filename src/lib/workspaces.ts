import { db } from "@/db";
import { accounts, balanceSnapshots, categories, transactions } from "@/db/schema";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { addMonths, endOfDay, endOfMonth, format, parse, startOfDay, startOfMonth, subMonths } from "date-fns";
import { incomeRowSql } from "@/lib/spending";
import { classifyInvestmentActivity, contributionAmountCents, countedContributions, type InvestmentActivityKind } from "@/lib/investment-activity";

// HSAs hold invested money and their only positive rows are sweep legs and dividends, never pay.
const INVESTMENT_TYPES = ["brokerage", "ira", "crypto", "hsa"] as const;

export type WorkspaceTransaction = {
  id: number;
  accountId: number;
  accountName: string;
  amountCents: number;
  merchantRaw: string;
  postedAt: Date;
  categoryName: string;
  categoryId: number | null;
};

export type PieSlice = { id: string; name: string; valueCents: number; count?: number };
export type TrendPoint = { month: string; valueCents: number; secondaryCents?: number };

export type EarningsWorkspace = {
  monthKey: string;
  monthLabel: string;
  /** Cash that arrived in non-investment accounts. */
  totalCents: number;
  monthCents: number;
  /** Retirement-account deposits, deliberately separate from cash income. */
  monthRetirementContributionCents: number;
  monthEarnedAndInvestedCents: number;
  averageMonthlyCents: number;
  sources: PieSlice[];
  accounts: PieSlice[];
  trend: TrendPoint[];
  transactions: WorkspaceTransaction[];
  retirementContributionCents: number;
  retirementContributionCount: number;
  contributions: WorkspaceTransaction[];
};

export type EarningsRange = {
  /** Inclusive YYYY-MM-DD. */
  from: string; to: string;
  /** Cash income inside the range. */
  rangeCents: number;
  /** Retirement-account deposits inside the range, deliberately separate from cash income. */
  retirementCents: number;
  earnedAndInvestedCents: number;
  /** Cash income per calendar month over the trend window. */
  averageMonthlyCents: number;
  /** Every cash income on record, any date. */
  totalCents: number;
  sources: PieSlice[];
  accounts: PieSlice[];
  /** Monthly: `valueCents` cash income, `secondaryCents` retirement deposits. */
  trend: TrendPoint[];
  transactions: WorkspaceTransaction[];
  transactionCount: number;
  contributions: WorkspaceTransaction[];
  /** All retirement deposits on record, any date. */
  retirementContributionCents: number;
  retirementContributionCount: number;
};

const TXN_LIMIT = 250;

/** Income is money that arrived, excluding refunds, internal moves, investments,
 * and never-count transactions. This mirrors the Made cash-flow treatment.
 * `trendStart` is the first month of the monthly trend (it may start before `start`). */
async function earningsBetween(start: Date, end: Date, trendStart: Date): Promise<EarningsRange> {
  const inRange = and(gte(transactions.postedAt, start), lte(transactions.postedAt, end));
  // Made's own row predicate, so Cash income and its drill-down agree with Spending.
  const income = incomeRowSql();
  const [totals, sourceRows, accountRows, trendRows, rows, retirementRows] = await Promise.all([
    db.select({
      total: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
      range: sql<number>`COALESCE(SUM(CASE WHEN ${inRange} THEN ${transactions.amountCents} ELSE 0 END), 0)`,
      count: sql<number>`COALESCE(SUM(CASE WHEN ${inRange} THEN 1 ELSE 0 END), 0)`,
    }).from(transactions).where(income).get(),
    db.select({
      id: sql<string>`COALESCE(CAST(${transactions.categoryId} AS TEXT), ${transactions.merchantRaw})`,
      name: sql<string>`COALESCE(${categories.name}, ${transactions.merchantRaw}, 'Uncategorized income')`,
      value: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    }).from(transactions).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(income, inRange)).groupBy(sql`COALESCE(CAST(${transactions.categoryId} AS TEXT), ${transactions.merchantRaw})`),
    db.select({ id: accounts.id, name: accounts.name, value: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`, count: sql<number>`COUNT(*)` })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(income, inRange)).groupBy(accounts.id),
    db.select({ month: sql<string>`strftime('%Y-%m', ${transactions.postedAt}, 'unixepoch')`, value: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)` })
      .from(transactions).where(and(income, gte(transactions.postedAt, trendStart), lte(transactions.postedAt, end))).groupBy(sql`strftime('%Y-%m', ${transactions.postedAt}, 'unixepoch')`),
    db.select({ id: transactions.id, accountId: transactions.accountId, accountName: accounts.name, amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, postedAt: transactions.postedAt, categoryName: sql<string>`COALESCE(${categories.name}, 'Uncategorized')`, categoryId: transactions.categoryId })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(income, inRange)).orderBy(desc(transactions.postedAt)).limit(TXN_LIMIT),
    db.select({ id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, postedAt: transactions.postedAt, categoryName: categories.name, categoryKind: categories.kind, categoryId: transactions.categoryId, accountType: accounts.type, accountName: accounts.name })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inArray(accounts.type, [...INVESTMENT_TYPES]), eq(transactions.isExcluded, false))),
  ]);
  const allRetirementContributions = countedContributions(retirementRows).filter((row) =>
    row.accountType === "ira" || /\b401\s?\(?k\)?|403\s?\(?b\)?|retirement\b/i.test(row.accountName),
  );
  const retirementByMonth = new Map<string, number>();
  for (const row of allRetirementContributions) {
    const m = format(row.postedAt, "yyyy-MM");
    retirementByMonth.set(m, (retirementByMonth.get(m) ?? 0) + contributionAmountCents(row.amountCents));
  }
  const trendMap = new Map(trendRows.map((row) => [row.month, row.value]));
  const trend: TrendPoint[] = [];
  for (let m = startOfMonth(trendStart); m <= end; m = addMonths(m, 1)) {
    const month = format(m, "yyyy-MM");
    trend.push({ month, valueCents: trendMap.get(month) ?? 0, secondaryCents: retirementByMonth.get(month) ?? 0 });
  }
  const retirementContributions = allRetirementContributions.filter((row) => row.postedAt >= start && row.postedAt <= end).sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  const retirementCents = retirementContributions.reduce((sum, row) => sum + contributionAmountCents(row.amountCents), 0);
  const rangeCents = totals?.range ?? 0;
  return {
    from: format(start, "yyyy-MM-dd"), to: format(end, "yyyy-MM-dd"),
    rangeCents, retirementCents, earnedAndInvestedCents: rangeCents + retirementCents,
    averageMonthlyCents: trend.length ? Math.round(trend.reduce((sum, point) => sum + point.valueCents, 0) / trend.length) : 0,
    totalCents: totals?.total ?? 0,
    sources: sourceRows.filter((x) => x.value > 0).map((x) => ({ id: x.id, name: x.name || "Uncategorized income", valueCents: x.value, count: x.count })).sort((a, b) => b.valueCents - a.valueCents),
    accounts: accountRows.filter((x) => x.value > 0).map((x) => ({ id: String(x.id), name: x.name, valueCents: x.value, count: x.count })).sort((a, b) => b.valueCents - a.valueCents),
    trend, transactions: rows, transactionCount: totals?.count ?? rows.length,
    contributions: retirementContributions.map((row) => ({ id: row.id, accountId: row.accountId, accountName: row.accountName, amountCents: contributionAmountCents(row.amountCents), merchantRaw: row.merchantRaw, postedAt: row.postedAt, categoryName: row.categoryName ?? "Retirement contribution", categoryId: row.categoryId })),
    retirementContributionCents: allRetirementContributions.reduce((sum, row) => sum + contributionAmountCents(row.amountCents), 0),
    retirementContributionCount: allRetirementContributions.length,
  };
}

/** Earnings for inclusive YYYY-MM-DD bounds; `from` null = since the first transaction. The trend covers at least six months. */
export async function getEarningsRange(from: string | null, to: string | null): Promise<EarningsRange> {
  const end = endOfDay(to ? parse(to, "yyyy-MM-dd", new Date()) : new Date());
  let start: Date;
  if (from) start = startOfDay(parse(from, "yyyy-MM-dd", new Date()));
  else {
    const first = await db.select({ d: sql<number | null>`MIN(${transactions.postedAt})` }).from(transactions).get();
    start = startOfDay(first?.d ? new Date(first.d * 1000) : end);
  }
  const sixBack = startOfMonth(subMonths(end, 5));
  return earningsBetween(start, end, start < sixBack ? startOfMonth(start) : sixBack);
}

/** One calendar month, the shape `fin earnings` prints. */
export async function getEarningsWorkspace(requestedMonth?: string): Promise<EarningsWorkspace> {
  const validMonth = requestedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth);
  const monthStart = startOfMonth(validMonth ? parse(`${requestedMonth}-01`, "yyyy-MM-dd", new Date()) : new Date());
  const r = await earningsBetween(monthStart, endOfMonth(monthStart), startOfMonth(subMonths(monthStart, 5)));
  return {
    monthKey: format(monthStart, "yyyy-MM"), monthLabel: format(monthStart, "MMMM yyyy"),
    totalCents: r.totalCents, monthCents: r.rangeCents, monthRetirementContributionCents: r.retirementCents, monthEarnedAndInvestedCents: r.earnedAndInvestedCents,
    averageMonthlyCents: r.averageMonthlyCents, sources: r.sources, accounts: r.accounts,
    trend: r.trend.map(({ month, valueCents }) => ({ month, valueCents })), transactions: r.transactions,
    retirementContributionCents: r.retirementContributionCents, retirementContributionCount: r.retirementContributionCount, contributions: r.contributions,
  };
}

export type InvestmentActivity = WorkspaceTransaction & { activityKind: InvestmentActivityKind; activityLabel: string; displayAmountCents: number; sourceAccountName: string | null; isInternalTransfer: boolean };
export type InvestmentAccount = { id: number; name: string; type: string; balanceCents: number; institution: string | null; activity: InvestmentActivity[]; snapshots: { date: string; valueCents: number }[] };
export type InvestmentsWorkspace = { totalCents: number; accounts: InvestmentAccount[]; byType: PieSlice[]; trend: TrendPoint[]; activity: InvestmentActivity[] };

/** Investment balances are authoritative account/snapshot values. Investment
 * transactions are activity only; contributions and withdrawals never become spending.
 * Money in and out for a range is getInvestmentFlows, not this: `activity` is only the latest rows. */
export async function getInvestmentsWorkspace(): Promise<InvestmentsWorkspace> {
  const investmentAccounts = await db.query.accounts.findMany({
    where: and(eq(accounts.isActive, true), inArray(accounts.type, [...INVESTMENT_TYPES])),
    with: { institution: true }, orderBy: [desc(accounts.currentBalanceCents)],
  });
  const ids = investmentAccounts.map((a) => a.id);
  if (!ids.length) return { totalCents: 0, accounts: [], byType: [], trend: [], activity: [] };
  const [activityRows, snapshots] = await Promise.all([
    db.select({ id: transactions.id, accountId: transactions.accountId, accountName: accounts.name, amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, postedAt: transactions.postedAt, categoryName: sql<string>`COALESCE(${categories.name}, 'Uncategorized')`, categoryKind: categories.kind, categoryId: transactions.categoryId, transferPairTxnId: transactions.transferPairTxnId, isTransfer: transactions.isTransfer })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inArray(transactions.accountId, ids), eq(transactions.isExcluded, false))).orderBy(desc(transactions.postedAt)).limit(300),
    db.select({ accountId: balanceSnapshots.accountId, date: balanceSnapshots.date, valueCents: balanceSnapshots.balanceCents })
      .from(balanceSnapshots).where(inArray(balanceSnapshots.accountId, ids)).orderBy(asc(balanceSnapshots.date)),
  ]);
  const pairIds = activityRows.flatMap((row) => row.transferPairTxnId == null ? [] : [row.transferPairTxnId]);
  const pairRows = pairIds.length ? await db.select({ id: transactions.id, accountName: accounts.name }).from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).where(inArray(transactions.id, pairIds)) : [];
  const pairAccountById = new Map(pairRows.map((row) => [row.id, row.accountName]));
  const activity: InvestmentActivity[] = activityRows.map((row) => {
    const classification = classifyInvestmentActivity(row);
    return { ...row, activityKind: classification.kind, activityLabel: classification.label, displayAmountCents: Math.abs(row.amountCents), sourceAccountName: row.transferPairTxnId == null ? null : pairAccountById.get(row.transferPairTxnId) ?? null, isInternalTransfer: row.isTransfer };
  });
  // The redundant leg of a double-reported contribution stays visible in the list, marked as such.
  const counted = countedContributions(activityRows);
  const countedIds = new Set(counted.map((row) => row.id));
  for (const row of activity) if (row.activityKind === "contribution" && !countedIds.has(row.id)) row.activityLabel = "Contribution (duplicate leg)";
  const byType = new Map<string, number>();
  for (const account of investmentAccounts) byType.set(account.type, (byType.get(account.type) ?? 0) + account.currentBalanceCents);
  const snapshotByDate = new Map<string, { sum: number; accountIds: Set<number> }>();
  for (const snapshot of snapshots) {
    const point = snapshotByDate.get(snapshot.date) ?? { sum: 0, accountIds: new Set<number>() };
    point.sum += snapshot.valueCents;
    point.accountIds.add(snapshot.accountId);
    snapshotByDate.set(snapshot.date, point);
  }
  // A portfolio point is only meaningful when every investment account had a
  // recorded balance that day; partial snapshots would otherwise imply a loss.
  const trend = [...snapshotByDate]
    .filter(([, point]) => point.accountIds.size === ids.length)
    .map(([month, point]) => ({ month, valueCents: point.sum }));
  return {
    totalCents: investmentAccounts.reduce((total, a) => total + a.currentBalanceCents, 0),
    byType: [...byType].map(([name, valueCents]) => ({ id: name, name: name.toUpperCase(), valueCents })).sort((a, b) => b.valueCents - a.valueCents),
    accounts: investmentAccounts.map((account) => ({
      id: account.id, name: account.name, type: account.type, balanceCents: account.currentBalanceCents, institution: account.institution?.name ?? null,
      activity: activity.filter((row) => row.accountId === account.id), snapshots: snapshots.filter((row) => row.accountId === account.id),
    })),
    trend, activity,
  };
}

export type TransferItem = WorkspaceTransaction & { pairedTransactionId: number | null; pairedAccountId: number | null; pairedAccountName: string | null; pairedAmountCents: number | null; isManualPair: boolean };
export type TransfersWorkspace = { totalCents: number; matchedCount: number; unpairedCount: number; accounts: PieSlice[]; transfers: TransferItem[] };

/** Internal transfers remain in the ledger, but are excluded from both earnings
 * and spending. Paired rows are presented once so a checking→card payment is
 * not visually double counted either. */
export async function getTransfersWorkspace(): Promise<TransfersWorkspace> {
  const rows = await db.query.transactions.findMany({
    where: eq(transactions.isTransfer, true), with: { account: true }, orderBy: (t, { desc }) => [desc(t.postedAt)],
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visible = rows.filter((row) => !row.transferPairTxnId || row.id < row.transferPairTxnId || !byId.has(row.transferPairTxnId));
  const accountTotals = new Map<number, PieSlice>();
  const transfers: TransferItem[] = visible.map((row) => {
    const pair = row.transferPairTxnId ? byId.get(row.transferPairTxnId) : undefined;
    const current = accountTotals.get(row.accountId) ?? { id: String(row.accountId), name: row.account?.name ?? "Unknown account", valueCents: 0, count: 0 };
    current.valueCents += Math.abs(row.amountCents); current.count = (current.count ?? 0) + 1; accountTotals.set(row.accountId, current);
    return { id: row.id, accountId: row.accountId, accountName: row.account?.name ?? "Unknown account", amountCents: row.amountCents, merchantRaw: row.merchantRaw, postedAt: row.postedAt, categoryName: "Internal transfer", categoryId: row.categoryId, pairedTransactionId: pair?.id ?? null, pairedAccountId: pair?.accountId ?? null, pairedAccountName: pair?.account?.name ?? null, pairedAmountCents: pair?.amountCents ?? null, isManualPair: row.transferPairTxnId != null };
  });
  return { totalCents: transfers.reduce((sum, row) => sum + Math.abs(row.amountCents), 0), matchedCount: transfers.filter((row) => row.pairedTransactionId != null).length, unpairedCount: transfers.filter((row) => row.pairedTransactionId == null).length, accounts: [...accountTotals.values()].sort((a, b) => b.valueCents - a.valueCents), transfers };
}
