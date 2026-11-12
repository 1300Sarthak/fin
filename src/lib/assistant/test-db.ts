/**
 * Fixtures for the assistant tests. The database itself is the throwaway file
 * `src/test-preload.ts` created; this file re-checks that the live
 * connection really points at it before anything is written.
 */
import { dirname } from "node:path";
import { db, schema } from "@/db";

const list = await db.all<{ file: string }>(`PRAGMA database_list` as never).catch(() => []);
const file = list.find((r) => r.file.endsWith("test.db"))?.file;
if (!file || !file.includes("finance-test-")) throw new Error("test database is not the temp file; refusing to run");
export const dir = dirname(file);
export { db, schema };

export const MONTH = "2026-03";
export const at = (day: number) => new Date(Date.UTC(2026, 2, day, 12));

/** Categories, three accounts and a handful of March 2026 rows. Run once per process: test files share one database. */
export const seed = () => (seeded ??= build());
let seeded: ReturnType<typeof build> | undefined;
async function build() {
  const cats = await db.insert(schema.categories).values([
    { name: "Groceries", kind: "expense" }, { name: "Restaurants", kind: "expense" },
    { name: "Paycheck", kind: "income" }, { name: "Transfer", kind: "transfer" },
  ]).returning();
  const [checking, brokerage, card] = await db.insert(schema.accounts).values([
    { name: "Checking ••1234 (x9876)", type: "checking", externalId: "SECRET-ACCT-EXT", source: "simplefin", currentBalanceCents: 500000 },
    { name: "Brokerage", type: "brokerage", source: "manual", currentBalanceCents: 900000 },
    { name: "Visa", type: "credit", isAsset: false, source: "manual", currentBalanceCents: 20000 },
  ]).returning();
  await db.insert(schema.balanceSnapshots).values([{ accountId: checking.id, date: "2026-03-20", balanceCents: 500000, isAsset: true }]);
  const cat = (n: string) => cats.find((c) => c.name === n)!.id;
  const rows = await db.insert(schema.transactions).values([
    { accountId: checking.id, postedAt: at(10), amountCents: -10000, merchantRaw: "Dinner at Luigi's", payeeNormalized: "dinner at luigi's", memo: "memo-secret", note: "note-secret", externalId: "SECRET-TXN-EXT-1", categoryId: cat("Restaurants"), source: "simplefin" },
    { accountId: checking.id, postedAt: at(12), amountCents: -4000, merchantRaw: "Market", payeeNormalized: "market", externalId: "SECRET-TXN-EXT-2", categoryId: cat("Groceries"), source: "simplefin" },
    { accountId: checking.id, postedAt: at(14), amountCents: 7500, merchantRaw: "Venmo from Sam", payeeNormalized: "from sam", externalId: "SECRET-TXN-EXT-3", categoryId: cat("Paycheck"), source: "simplefin" },
    { accountId: checking.id, postedAt: at(15), amountCents: 300000, merchantRaw: "Payroll", payeeNormalized: "payroll", externalId: "SECRET-TXN-EXT-4", categoryId: cat("Paycheck"), source: "simplefin" },
    { accountId: card.id, postedAt: at(16), amountCents: 5000, merchantRaw: "Venmo to card", payeeNormalized: "to card", externalId: "SECRET-TXN-EXT-5", source: "simplefin" },
    { accountId: checking.id, postedAt: at(5), amountCents: -2500, merchantRaw: "=HYPERLINK(\"http://evil\")", payeeNormalized: "evil", externalId: "SECRET-TXN-EXT-6", categoryId: cat("Groceries"), source: "simplefin" },
  ]).returning();
  return { cats, cat, checking, brokerage, card, dinner: rows[0], market: rows[1], venmo: rows[2], payroll: rows[3], cardCredit: rows[4], evil: rows[5] };
}
