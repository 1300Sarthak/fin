/**
 * What sits outside spendable cash flow, in one place so Overview, Spending,
 * History, burn, refunds, anomalies and the assistant cannot drift apart.
 *
 * Pure: imports the table definitions for the SQL predicate but never opens
 * the database, so `burn-core` can still be tested on fixtures.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { transactions } from "@/db/schema";
import { SWEEP_EXACT, isSweepText, sweepKey } from "@/lib/investment-activity";

/** Money moving into these accounts is investing (or HSA saving), not spending, income or a refund. */
export const INVESTMENT_ACCOUNT_TYPES = ["brokerage", "ira", "crypto", "hsa"] as const;

export const isInvestmentAccountType = (type: string): boolean =>
  (INVESTMENT_ACCOUNT_TYPES as readonly string[]).includes(type);

/**
 * Accounts with a money-market core that books sweep legs: investment-type
 * accounts and a cash-management account (Fidelity's is a "checking" account).
 * A bare "FIDELITY" debit at an ordinary bank is a payment or a transfer, so
 * the sweep rule never applies there; categories decide it.
 */
export const isSweepAccount = (type: string, name: string): boolean =>
  isInvestmentAccountType(type) || sweepKey(name).includes("cashmanagement");

/** A money-market sweep leg: neither made, spent, nor a refund. */
export const isCashSweep = (row: { merchantRaw: string; accountType: string; accountName: string }): boolean =>
  isSweepAccount(row.accountType, row.accountName) && isSweepText(row.merchantRaw);

/** SQL twin of `sweepKey`: lower() and replace() touch exactly the characters the JS does. */
const sweepKeySql = (text: SQLWrapper): SQL => {
  let stripped: SQL = sql`${text}`;
  for (const code of [9, 10, 11, 12, 13, 32]) stripped = sql`replace(${stripped}, char(${sql.raw(String(code))}), '')`;
  return sql`lower(${stripped})`;
};

/** SQL twin of `isSweepText` over any text expression. */
export const sweepTextSql = (text: SQLWrapper): SQL => {
  const key = sweepKeySql(text);
  const exact = sql.join(SWEEP_EXACT.map((s) => sql`${s}`), sql`, `);
  return sql`(${key} IN (${exact}) OR (instr(${key}, 'fidelity') > 0 AND instr(${key}, 'moneymarket') > 0))`;
};

/** SQL twin of `isCashSweep` for a `transactions` row. */
// The subquery names its own alias (`sweep_acct`) with raw identifiers: inside
// drizzle's relational `findMany`, interpolated columns of another table are
// re-qualified with the root alias, which rendered `"transactions"."type"`.
export const cashSweepSql = (): SQL =>
  sql`(${sweepTextSql(transactions.merchantRaw)} AND ${transactions.accountId} IN (SELECT sweep_acct.id FROM accounts AS sweep_acct WHERE sweep_acct.type IN (${sql.join(INVESTMENT_ACCOUNT_TYPES.map((t) => sql`${t}`), sql`, `)}) OR instr(${sweepKeySql(sql.raw("sweep_acct.name"))}, 'cashmanagement') > 0))`;
