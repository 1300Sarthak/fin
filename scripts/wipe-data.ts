/**
 * Wipe synced + derived data (accounts, transactions, balances, budgets,
 * recurring series, merchant cache, learned rules) WITHOUT touching your
 * SimpleFIN connection, categories, system rules, goals, or config.
 *
 * Use this to start the dashboard fresh while keeping your linked accounts —
 * unlike `db:reset`, it won't make you re-claim a token.
 *   bun run db:wipe
 */
import { db } from "../src/db";
import {
  transactions,
  balanceSnapshots,
  recurringSeries,
  budgets,
  merchantCache,
  accounts,
  institutions,
  categoryRules,
  goals,
} from "../src/db/schema";
import { eq } from "drizzle-orm";

// children first (FK-friendly), then parents
await db.delete(transactions);
await db.delete(balanceSnapshots);
await db.delete(recurringSeries);
await db.delete(budgets);
await db.delete(merchantCache);
await db.delete(accounts);
await db.delete(institutions);
// keep system rules; drop only user-learned ones (they came from old data)
await db.delete(categoryRules).where(eq(categoryRules.createdBy, "user"));
// goals are kept, but unlink any account references we just deleted
await db.update(goals).set({ linkedAccountId: null });

console.log(
  "✓ wiped synced + derived data — connection, categories, rules, goals, and config kept",
);
process.exit(0);
