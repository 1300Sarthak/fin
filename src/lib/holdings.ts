import { db } from "@/db";
import { holdings, accounts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { isInvestmentAccountType } from "@/lib/cashflow-scope";

/**
 * What is actually held, as opposed to what it is worth. `getAccountTotals`
 * answers "how much money is in there"; this answers "in what", which is a
 * different question and the one that catches an account sitting in cash.
 *
 * Provider prices lag one trading day, so `asOf` travels with every row and
 * callers are expected to show it. Cost basis is per-share and sometimes
 * absent (crypto), so `gainPct` is null rather than zero when unknown.
 */
export type Holding = {
  id: number;
  accountId: number;
  accountName: string;
  symbol: string | null;
  description: string | null;
  shares: number;
  marketValueCents: number;
  costPerShareCents: number | null;
  costBasisCents: number | null;
  gainCents: number | null;
  gainPct: number | null;
  /** Share of its own account, 0-100. */
  pctOfAccount: number;
  asOf: Date;
};

/** Money-market and settlement funds: held inside a brokerage, but not invested. */
const CASH_SYMBOLS = new Set(["SPAXX", "FDRXX", "FZFXX", "SPRXX", "VMFXX", "CASH"]);
export const isCashLike = (symbol: string | null, description: string | null): boolean =>
  (symbol != null && CASH_SYMBOLS.has(symbol.toUpperCase())) ||
  /money market/i.test(description ?? "");

export async function getHoldings(accountId?: number): Promise<Holding[]> {
  const rows = await db
    .select({
      id: holdings.id,
      accountId: holdings.accountId,
      accountName: accounts.name,
      symbol: holdings.symbol,
      description: holdings.description,
      shares: holdings.shares,
      marketValueCents: holdings.marketValueCents,
      costPerShareCents: holdings.costPerShareCents,
      asOf: holdings.asOf,
    })
    .from(holdings)
    .innerJoin(accounts, eq(accounts.id, holdings.accountId))
    .where(accountId ? eq(holdings.accountId, accountId) : undefined)
    .orderBy(desc(holdings.marketValueCents));

  const byAccount = new Map<number, number>();
  for (const r of rows) {
    byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? 0) + r.marketValueCents);
  }

  return rows.map((r) => {
    const basis =
      r.costPerShareCents != null ? Math.round(r.costPerShareCents * r.shares) : null;
    const gain = basis != null && basis > 0 ? r.marketValueCents - basis : null;
    const total = byAccount.get(r.accountId) ?? 0;
    return {
      ...r,
      costBasisCents: basis,
      gainCents: gain,
      gainPct: gain != null && basis ? (gain / basis) * 100 : null,
      pctOfAccount: total ? (r.marketValueCents / total) * 100 : 0,
    };
  });
}

export type PortfolioSummary = {
  totalCents: number;
  investedCents: number;
  /** Money-market and settlement balances — inside the account, out of the market. */
  cashCents: number;
  cashPct: number;
  positions: number;
  asOf: Date | null;
  /** Largest single non-cash position as a share of the whole, 0-100. */
  topConcentrationPct: number;
  topSymbol: string | null;
};

export async function getPortfolioSummary(accountId?: number): Promise<PortfolioSummary> {
  const rows = await getHoldings(accountId);
  const total = rows.reduce((s, r) => s + r.marketValueCents, 0);
  const cash = rows
    .filter((r) => isCashLike(r.symbol, r.description))
    .reduce((s, r) => s + r.marketValueCents, 0);
  const invested = rows.filter((r) => !isCashLike(r.symbol, r.description));
  const top = invested[0];
  return {
    totalCents: total,
    investedCents: total - cash,
    cashCents: cash,
    cashPct: total ? (cash / total) * 100 : 0,
    positions: invested.length,
    asOf: rows.length ? rows.reduce((a, r) => (r.asOf > a ? r.asOf : a), rows[0].asOf) : null,
    topConcentrationPct: top && total ? (top.marketValueCents / total) * 100 : 0,
    topSymbol: top?.symbol ?? null,
  };
}

/**
 * Why the Investments headline and `fin holdings` disagree. The headline is
 * active investment-account balances as the institutions report them, which
 * include cash not listed as a position; `fin holdings` sums every position,
 * including ones held in a non-investment account (a cash-management account).
 */
export type InvestmentValueGap = {
  /** Active investment-account balances: the Investments headline. */
  accountValueCents: number;
  /** Positions inside those same accounts. */
  positionsCents: number;
  /** accountValue − positions: cash the account holds outside its positions. */
  uninvestedCents: number;
  /** Positions in any other account; `fin holdings` counts these too. */
  positionsElsewhereCents: number;
  /** Every position: the `fin holdings` total. */
  allPositionsCents: number;
};

export async function getInvestmentValueGap(): Promise<InvestmentValueGap> {
  const [accts, rows] = await Promise.all([
    db.select({ id: accounts.id, type: accounts.type, isActive: accounts.isActive, balanceCents: accounts.currentBalanceCents }).from(accounts),
    db.select({ accountId: holdings.accountId, valueCents: holdings.marketValueCents }).from(holdings),
  ]);
  const inScope = new Set(accts.filter((a) => a.isActive && isInvestmentAccountType(a.type)).map((a) => a.id));
  const accountValueCents = accts.filter((a) => inScope.has(a.id)).reduce((s, a) => s + a.balanceCents, 0);
  const positionsCents = rows.filter((r) => inScope.has(r.accountId)).reduce((s, r) => s + r.valueCents, 0);
  const allPositionsCents = rows.reduce((s, r) => s + r.valueCents, 0);
  return {
    accountValueCents,
    positionsCents,
    uninvestedCents: accountValueCents - positionsCents,
    positionsElsewhereCents: allPositionsCents - positionsCents,
    allPositionsCents,
  };
}

/** The one-line explanation the page and the CLI both print. */
export function investmentValueGapNote(g: InvestmentValueGap, usd: (cents: number) => string): string {
  const elsewhere = g.positionsElsewhereCents
    ? ` Positions across every account (fin holdings) are ${usd(g.allPositionsCents)}, including ${usd(g.positionsElsewhereCents)} held outside investment accounts.`
    : "";
  return `Account value ${usd(g.accountValueCents)} is positions ${usd(g.positionsCents)} plus ${usd(g.uninvestedCents)} of uninvested cash the accounts hold outside their positions.${elsewhere}`;
}
