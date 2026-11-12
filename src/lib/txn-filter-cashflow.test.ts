import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, transactions } from "@/db/schema";
import { getCashAccount } from "./cash";
import { getCashflow, getSpendingTransactions } from "./spending";
import { daySpan } from "./spending-summary";
import { getFilteredTransactions } from "./txn-filter";

// 2031 so nothing another test file seeds (2026) lands in these ranges.
const day = (iso: string) => new Date(`${iso}T12:00:00`);
// Removed afterwards: other test files expect a fresh Cash account.
const made = { txns: [] as number[], accounts: [] as number[], categories: [] as number[] };

beforeAll(async () => {
  const cats = await db.insert(categories).values([
    { name: "DrillFood", kind: "expense" }, { name: "DrillPay", kind: "income" },
    { name: "DrillMove", kind: "transfer" }, { name: "DrillInvest", kind: "investment" },
  ]).returning();
  made.categories.push(...cats.map((c) => c.id));
  const cat = (n: string) => cats.find((c) => c.name === n)!.id;
  const [bank, card, broker, cashMgmt] = await db.insert(accounts).values([
    { name: "Drill Checking", type: "checking", source: "manual" },
    { name: "Drill Card", type: "credit", isAsset: false, source: "manual" },
    { name: "Drill Brokerage", type: "brokerage", source: "manual" },
    { name: "Drill Cash Management", type: "checking", source: "manual" },
  ]).returning();
  made.accounts.push(bank.id, card.id, broker.id, cashMgmt.id);
  let cash = await getCashAccount();
  if (!cash) {
    [cash] = await db.insert(accounts).values({ name: "Cash", type: "cash", source: "manual" }).returning();
    made.accounts.push(cash.id);
  }
  const row = (accountId: number, iso: string, amountCents: number, merchantRaw: string, extra: Partial<typeof transactions.$inferInsert> = {}) =>
    ({ accountId, postedAt: day(iso), amountCents, merchantRaw, source: "manual" as const, ...extra });
  const [shoes] = await db.insert(transactions).values(row(card.id, "2031-11-03", -12_000, "Shoe Store", { categoryId: cat("DrillFood") })).returning();
  made.txns.push(shoes.id);
  const rest = await db.insert(transactions).values([
    row(card.id, "2031-11-02", -4_550, "Grocer", { categoryId: cat("DrillFood") }),
    row(card.id, "2031-11-05", -999, "Uncategorized buy"),
    // Linked refund: comes off the shoes, never listed as spending on its own.
    row(card.id, "2031-11-07", 2_000, "Shoe Store refund", { isRefund: true, refundsTxnId: shoes.id }),
    // Unlinked refund: listed, and reduces Spent.
    row(card.id, "2031-11-08", 700, "Mystery credit", { isRefund: true }),
    row(bank.id, "2031-11-01", 250_000, "Payroll", { categoryId: cat("DrillPay") }),
    row(bank.id, "2031-11-04", 1_500, "Venmo from Sam"),
    // None of these are spent or made.
    row(bank.id, "2031-11-06", -200_000, "Account Transfer", { categoryId: cat("DrillMove") }),
    row(bank.id, "2031-11-06", -50_000, "Transfers", { isTransfer: true }),
    row(bank.id, "2031-11-09", -15_475, "Coinbase buy", { categoryId: cat("DrillInvest") }),
    row(bank.id, "2031-11-10", -3_000, "Ignored", { isExcluded: true, categoryId: cat("DrillFood") }),
    row(bank.id, "2031-11-10", 9_000, "Pay back to me", { categoryId: cat("DrillMove") }),
    row(broker.id, "2031-11-06", -5_000, "Fee", { categoryId: cat("DrillFood") }),
    row(broker.id, "2031-11-06", 50_000, "Deposit"),
    row(cashMgmt.id, "2031-11-06", -80_000, "FIDELITY"),
    row(cashMgmt.id, "2031-11-06", 80_000, "Fidelity Government Money Market"),
    // Cash wallet spending counts in cash flow.
    row(cash.id, "2031-11-11", -1_658, "thai food", { categoryId: cat("DrillFood") }),
    // Outside Nov 1-12, inside October / YTD.
    row(card.id, "2031-10-15", -7_700, "October dinner", { categoryId: cat("DrillFood") }),
    row(bank.id, "2031-10-31", 250_000, "Payroll", { categoryId: cat("DrillPay") }),
    row(card.id, "2031-11-20", -3_300, "Later this month", { categoryId: cat("DrillFood") }),
  ]).returning({ id: transactions.id });
  made.txns.push(...rest.map((r) => r.id));
});

afterAll(async () => {
  await db.delete(transactions).where(inArray(transactions.id, made.txns));
  await db.delete(accounts).where(inArray(accounts.id, made.accounts));
  await db.delete(categories).where(inArray(categories.id, made.categories));
});

const RANGES = [
  ["Nov 1-12", "2031-11-01", "2031-11-12"],
  ["October", "2031-10-01", "2031-10-31"],
  ["YTD", "2031-01-01", "2031-11-12"],
] as const;

describe("kind=expense / kind=income drill-downs match getCashflow", () => {
  for (const [name, from, to] of RANGES) {
    test(name, async () => {
      const flow = await getCashflow(daySpan(from, to));
      const spending = await getSpendingTransactions(daySpan(from, to));
      const expense = await getFilteredTransactions({ from, to, kind: "expense" }, { limit: 1000 });
      const income = await getFilteredTransactions({ from, to, kind: "income" }, { limit: 1000 });

      expect(expense.totals.outCents).toBe(flow.spendingCents);
      expect(expense.totals.netCents).toBe(-flow.spendingCents);
      expect(expense.rows.map((r) => r.id).sort()).toEqual(spending.map((r) => r.id).sort());
      expect(expense.totals.count).toBe(spending.length);

      expect(income.totals.inCents).toBe(flow.incomeCents);
      expect(income.rows.reduce((s, r) => s + r.amountCents, 0)).toBe(flow.incomeCents);
      expect(income.totals.count).toBe(income.rows.length);
    });
  }

  test("Nov 1-12 drops transfers, investing, sweeps, exclusions and linked refunds", async () => {
    const expense = await getFilteredTransactions({ from: "2031-11-01", to: "2031-11-12", kind: "expense" });
    expect(expense.rows.map((r) => r.merchantRaw).sort()).toEqual(["Grocer", "Mystery credit", "Shoe Store", "Uncategorized buy", "thai food"]);
    // 120.00 - 20.00 linked + 45.50 + 9.99 - 7.00 unlinked + 16.58 cash.
    expect(expense.totals.outCents).toBe(16_507);
    const income = await getFilteredTransactions({ from: "2031-11-01", to: "2031-11-12", kind: "income" });
    expect(income.rows.map((r) => r.merchantRaw).sort()).toEqual(["Payroll", "Venmo from Sam"]);
  });

  test("an account filter narrows both sides the same way", async () => {
    const [card] = await db.select().from(accounts).where(eq(accounts.name, "Drill Card"));
    const flow = await getCashflow(daySpan("2031-11-01", "2031-11-12"), [card.id]);
    const expense = await getFilteredTransactions({ from: "2031-11-01", to: "2031-11-12", kind: "expense", account: card.id });
    expect(expense.totals.outCents).toBe(flow.spendingCents);
  });
});

describe("kind=cashflow is the Net drill-down", () => {
  for (const [name, from, to] of RANGES) {
    test(`${name}: the list's net is Made - Spent`, async () => {
      const flow = await getCashflow(daySpan(from, to));
      const income = await getFilteredTransactions({ from, to, kind: "income" }, { limit: 1000 });
      const spending = await getSpendingTransactions(daySpan(from, to));
      const all = await getFilteredTransactions({ from, to, kind: "cashflow" }, { limit: 1000 });

      expect(all.totals.inCents).toBe(flow.incomeCents);
      expect(all.totals.outCents).toBe(flow.spendingCents);
      expect(all.totals.netCents).toBe(flow.net);
      expect(all.rows.map((r) => r.id).sort()).toEqual([...income.rows, ...spending].map((r) => r.id).sort());
      expect(all.totals.count).toBe(all.rows.length);
    });
  }

  test("Nov 1-12 lists made and spent rows only, wallet included", async () => {
    const all = await getFilteredTransactions({ from: "2031-11-01", to: "2031-11-12", kind: "cashflow" });
    expect(all.rows.map((r) => r.merchantRaw).sort()).toEqual(["Grocer", "Mystery credit", "Payroll", "Shoe Store", "Uncategorized buy", "Venmo from Sam", "thai food"]);
    // 2,500.00 + 15.00 made, 165.07 spent (see above). The unfiltered list's net is far off.
    expect(all.totals.netCents).toBe(251_500 - 16_507);
    const loose = await getFilteredTransactions({ from: "2031-11-01", to: "2031-11-12" });
    expect(loose.totals.netCents).not.toBe(all.totals.netCents);
  });
});
