import { db } from "@/db";
import { accounts, balanceSnapshots, categories, transactions } from "@/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { endOfMonth, format, parse, startOfMonth, subMonths } from "date-fns";
import { classifyInvestmentActivity, contributionAmountCents, type InvestmentActivityKind } from "@/lib/investment-activity";

const INVESTMENT_TYPES = ["brokerage", "ira", "crypto"] as const;

const nonInvestmentAccount = notInArray(
  transactions.accountId,
  db.select({ id: accounts.id }).from(accounts).where(inArray(accounts.type, [...INVESTMENT_TYPES])),
);

const incomeActivity = and(
  eq(transactions.isTransfer, false),
  eq(transactions.isExcluded, false),
  eq(transactions.isRefund, false),
  nonInvestmentAccount,
  or(
    isNull(transactions.categoryId),
    notInArray(
      transactions.categoryId,
      db.select({ id: categories.id }).from(categories).where(inArray(categories.kind, ["transfer", "investment"])),
    ),
  ),
);

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

/** Income is money that arrived, excluding refunds, internal moves, investments,
 * and never-count transactions. This mirrors the Made cash-flow treatment. */
export async function getEarningsWorkspace(requestedMonth?: string): Promise<EarningsWorkspace> {
  const validMonth = requestedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth);
  const monthStart = startOfMonth(validMonth ? parse(`${requestedMonth}-01`, "yyyy-MM-dd", new Date()) : new Date());
  const monthEnd = endOfMonth(monthStart);
  const since = startOfMonth(subMonths(monthStart, 5));
  const [totals, sourceRows, accountRows, trendRows, rows, retirementRows] = await Promise.all([
    db.select({
      total: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
      month: sql<number>`COALESCE(SUM(CASE WHEN ${gte(transactions.postedAt, monthStart)} AND ${lte(transactions.postedAt, monthEnd)} THEN ${transactions.amountCents} ELSE 0 END), 0)`,
    }).from(transactions).where(and(incomeActivity, sql`${transactions.amountCents} > 0`)).get(),
    db.select({
      id: sql<string>`COALESCE(CAST(${transactions.categoryId} AS TEXT), ${transactions.merchantRaw})`,
      name: sql<string>`COALESCE(${categories.name}, ${transactions.merchantRaw}, 'Uncategorized income')`,
      value: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    }).from(transactions).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(incomeActivity, sql`${transactions.amountCents} > 0`, gte(transactions.postedAt, monthStart), lte(transactions.postedAt, monthEnd))).groupBy(sql`COALESCE(CAST(${transactions.categoryId} AS TEXT), ${transactions.merchantRaw})`),
    db.select({ id: accounts.id, name: accounts.name, value: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`, count: sql<number>`COUNT(*)` })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(incomeActivity, sql`${transactions.amountCents} > 0`, gte(transactions.postedAt, monthStart), lte(transactions.postedAt, monthEnd))).groupBy(accounts.id),
    db.select({ month: sql<string>`strftime('%Y-%m', ${transactions.postedAt}, 'unixepoch')`, value: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)` })
      .from(transactions).where(and(incomeActivity, sql`${transactions.amountCents} > 0`, gte(transactions.postedAt, since))).groupBy(sql`strftime('%Y-%m', ${transactions.postedAt}, 'unixepoch')`),
    db.select({ id: transactions.id, accountId: transactions.accountId, accountName: accounts.name, amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, postedAt: transactions.postedAt, categoryName: sql<string>`COALESCE(${categories.name}, 'Uncategorized')`, categoryId: transactions.categoryId })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(incomeActivity, sql`${transactions.amountCents} > 0`, gte(transactions.postedAt, monthStart), lte(transactions.postedAt, monthEnd))).orderBy(desc(transactions.postedAt)).limit(250),
    db.select({ id: transactions.id, accountId: transactions.accountId, amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, postedAt: transactions.postedAt, categoryName: categories.name, categoryKind: categories.kind, categoryId: transactions.categoryId, accountType: accounts.type, accountName: accounts.name })
      .from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(inArray(accounts.type, [...INVESTMENT_TYPES]), eq(transactions.isExcluded, false))),
  ]);
  const trendMap = new Map(trendRows.map((row) => [row.month, row.value]));
  const trend = Array.from({ length: 6 }, (_, index) => {
    const month = format(subMonths(monthStart, 5 - index), "yyyy-MM");
    return { month, valueCents: trendMap.get(month) ?? 0 };
  });
  const totalCents = totals?.total ?? 0;
  const allRetirementContributions = retirementRows.filter((row) =>
    classifyInvestmentActivity(row).kind === "contribution" &&
    (row.accountType === "ira" || /\b401\s?\(?k\)?|403\s?\(?b\)?|retirement\b/i.test(row.accountName)),
  );
  const retirementContributions = allRetirementContributions.filter((row) => row.postedAt >= monthStart && row.postedAt <= monthEnd);
  const monthRetirementContributionCents = retirementContributions.reduce((sum, row) => sum + contributionAmountCents(row.amountCents), 0);
  return {
    monthKey: format(monthStart, "yyyy-MM"), monthLabel: format(monthStart, "MMMM yyyy"),
    totalCents, monthCents: totals?.month ?? 0, monthRetirementContributionCents, monthEarnedAndInvestedCents: (totals?.month ?? 0) + monthRetirementContributionCents, averageMonthlyCents: Math.round(trend.reduce((sum, point) => sum + point.valueCents, 0) / 6),
    sources: sourceRows.filter((x) => x.value > 0).map((x) => ({ id: x.id, name: x.name || "Uncategorized income", valueCents: x.value, count: x.count })).sort((a, b) => b.valueCents - a.valueCents),
    accounts: accountRows.filter((x) => x.value > 0).map((x) => ({ id: String(x.id), name: x.name, valueCents: x.value, count: x.count })).sort((a, b) => b.valueCents - a.valueCents),
    trend, transactions: rows,
    retirementContributionCents: allRetirementContributions.reduce((sum, row) => sum + contributionAmountCents(row.amountCents), 0),
    retirementContributionCount: allRetirementContributions.length,
    contributions: retirementContributions.map((row) => ({ id: row.id, accountId: row.accountId, accountName: row.accountName, amountCents: contributionAmountCents(row.amountCents), merchantRaw: row.merchantRaw, postedAt: row.postedAt, categoryName: row.categoryName ?? "Retirement contribution", categoryId: row.categoryId })),
  };
}

export type InvestmentActivity = WorkspaceTransaction & { activityKind: InvestmentActivityKind; activityLabel: string; displayAmountCents: number; sourceAccountName: string | null; isInternalTransfer: boolean };
export type InvestmentAccount = { id: number; name: string; type: string; balanceCents: number; institution: string | null; activity: InvestmentActivity[]; snapshots: { date: string; valueCents: number }[] };
export type InvestmentsWorkspace = { totalCents: number; accounts: InvestmentAccount[]; byType: PieSlice[]; trend: TrendPoint[]; activity: InvestmentActivity[]; contributionCents: number; contributionCount: number; investmentIncomeCents: number; withdrawalCents: number; feeCents: number };

/** Investment balances are authoritative account/snapshot values. Investment
 * transactions are activity only; contributions and withdrawals never become spending. */
export async function getInvestmentsWorkspace(): Promise<InvestmentsWorkspace> {
  const investmentAccounts = await db.query.accounts.findMany({
    where: and(eq(accounts.isActive, true), inArray(accounts.type, [...INVESTMENT_TYPES])),
    with: { institution: true }, orderBy: [desc(accounts.currentBalanceCents)],
  });
  const ids = investmentAccounts.map((a) => a.id);
  if (!ids.length) return { totalCents: 0, accounts: [], byType: [], trend: [], activity: [], contributionCents: 0, contributionCount: 0, investmentIncomeCents: 0, withdrawalCents: 0, feeCents: 0 };
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
    contributionCents: activity.filter((row) => row.activityKind === "contribution").reduce((sum, row) => sum + contributionAmountCents(row.amountCents), 0),
    contributionCount: activity.filter((row) => row.activityKind === "contribution").length,
    investmentIncomeCents: activity.filter((row) => row.activityKind === "investment_income").reduce((sum, row) => sum + Math.max(row.amountCents, 0), 0),
    withdrawalCents: activity.filter((row) => row.activityKind === "withdrawal").reduce((sum, row) => sum + Math.abs(row.amountCents), 0),
    feeCents: activity.filter((row) => row.activityKind === "fee").reduce((sum, row) => sum + Math.abs(row.amountCents), 0),
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
