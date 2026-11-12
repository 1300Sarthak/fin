/**
 * The Overview, History and Spending consumers of Fidelity's ledger quirks:
 * one contribution booked as a same-day -/+ pair, and money-market sweeps in a
 * cash-management account filed as "Fees & Charges". Fixture rows copy the
 * shape of the real ones, dated 2025 so they stay clear of the shared fixtures.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db, schema } from "./assistant/test-db";
import { isSweepText } from "./investment-activity";

// Loaded after test-db has pointed DATABASE_URL at the temp file.
const { getCashflow, monthRange } = await import("@/lib/spending");
const { getPeriodHistory } = await import("@/lib/history");
const { retirementContributions } = await import("@/lib/networth");

const { accounts, categories, transactions, netWorthMilestones } = schema;
const day = (d: string) => new Date(`${d}T12:00:00Z`);
const made: { accounts: number[]; categories: number[]; milestones: number[]; txns: number[] } = { accounts: [], categories: [], milestones: [], txns: [] };

const MERCHANTS = [
  "Fidelity", " fidelity ", "Purchase into Fidelity Government Money Market", "Realizedgainloss", "Realized Gain Loss",
  "Fidelity Brokerage Services", "Monthly maintenance fee", "Electronic Funds Transfer Received", "FIDELITY INVESTMENTS",
];

beforeAll(async () => {
  const [fees, invest, transfer] = await db.insert(categories).values([
    { name: "Fees & Charges (sweep test)", kind: "expense" },
    { name: "Investments (sweep test)", kind: "investment" },
    { name: "Transfers (sweep test)", kind: "transfer" },
  ]).returning();
  made.categories.push(fees.id, invest.id, transfer.id);
  const [cma, roth, k401] = await db.insert(accounts).values([
    { name: "Cash Management (Individual) (6420)", type: "checking", source: "manual", currentBalanceCents: 20000 },
    { name: "ROTH IRA (3579)", type: "ira", source: "manual", currentBalanceCents: 1_000_000 },
    { name: "ACME 401(K) PLAN (9012)", type: "ira", source: "manual", currentBalanceCents: 300_000 },
  ]).returning();
  made.accounts.push(cma.id, roth.id, k401.id);
  const rows = await db.insert(transactions).values([
    // Cash management, September: one deposit and its sweep, a real fee, and
    // every merchant shape the sweep rule must agree with.
    { accountId: cma.id, postedAt: day("2025-09-09"), amountCents: 20000, merchantRaw: "Electronic Funds Transfer Received", categoryId: transfer.id },
    { accountId: cma.id, postedAt: day("2025-09-10"), amountCents: 9955, merchantRaw: "Fidelity", categoryId: fees.id },
    ...MERCHANTS.map((merchantRaw, i) => ({ accountId: cma.id, postedAt: day(`2025-09-${String(11 + i).padStart(2, "0")}`), amountCents: -(1000 + i), merchantRaw, categoryId: fees.id })),
    // Roth, July: the double-booked deposit plus its sweep leg.
    { accountId: roth.id, postedAt: day("2025-07-30"), amountCents: -300000, merchantRaw: "Cash Contribution Current Year", categoryId: fees.id },
    { accountId: roth.id, postedAt: day("2025-07-30"), amountCents: 300000, merchantRaw: "Fidelity", categoryId: fees.id },
    { accountId: roth.id, postedAt: day("2025-07-30"), amountCents: 300000, merchantRaw: "Current Year Contribution", categoryId: invest.id },
    // 401(k), August: a -/+ pair, then a single deposit; Roth: two real deposits of one size.
    { accountId: k401.id, postedAt: day("2025-08-14"), amountCents: -50000, merchantRaw: "Contribution", categoryId: invest.id },
    { accountId: k401.id, postedAt: day("2025-08-14"), amountCents: 50000, merchantRaw: "Contribution", categoryId: invest.id },
    { accountId: k401.id, postedAt: day("2025-08-31"), amountCents: 23000, merchantRaw: "Contribution", categoryId: invest.id },
    { accountId: roth.id, postedAt: day("2025-08-13"), amountCents: 10000, merchantRaw: "Current Year Contribution", categoryId: invest.id },
    { accountId: roth.id, postedAt: day("2025-08-13"), amountCents: 10000, merchantRaw: "Current Year Contribution", categoryId: invest.id },
  ]).returning();
  made.txns.push(...rows.map((r) => r.id));
  const ms = await db.insert(netWorthMilestones).values(
    ["2025-07-31", "2025-08-31", "2025-09-30"].map((date) => ({ date, label: `sweep test ${date}`, totalCents: 1 })),
  ).returning();
  made.milestones.push(...ms.map((m) => m.id));
});

afterAll(async () => {
  await db.delete(transactions).where(inArray(transactions.id, made.txns));
  await db.delete(netWorthMilestones).where(inArray(netWorthMilestones.id, made.milestones));
  await db.delete(accounts).where(inArray(accounts.id, made.accounts));
  await db.delete(categories).where(inArray(categories.id, made.categories));
});

describe("money-market sweeps in a cash-management account", () => {
  test("are neither made nor spent; a real fee still counts", async () => {
    const flow = await getCashflow(monthRange("2025-09"), [made.accounts[0]]);
    // Only the non-sweep merchants count: maintenance fee, the EFT text, the brokerage names.
    const expected = MERCHANTS.map((m, i) => (isSweepText(m) ? 0 : 1000 + i)).reduce((s, v) => s + v, 0);
    expect(flow.spendingCents).toBe(expected);
    expect(flow.spendingCents).toBe(1005 + 1006 + 1007 + 1008);
    expect(flow.incomeCents).toBe(0);
  });

  test("History drops them from spent and made", async () => {
    const sep = (await getPeriodHistory("month")).find((r) => r.key === "2025-09");
    expect(sep?.spendingCents).toBe(1005 + 1006 + 1007 + 1008);
    expect(sep?.incomeCents).toBe(0);
  });
});

describe("retirement deposits Fidelity books twice", () => {
  test("History counts each once, keeps two real same-day deposits, and keeps a 401(k) pair", async () => {
    const rows = await getPeriodHistory("month");
    expect(rows.find((r) => r.key === "2025-07")?.retirementContributionCents).toBe(300000);
    expect(rows.find((r) => r.key === "2025-08")?.retirementContributionCents).toBe(50000 + 23000 + 20000);
  });

  test("the Overview helper keeps one leg of a pair and both of two real deposits", () => {
    const base = { merchantRaw: "Current Year Contribution", categoryName: "Investments", categoryKind: "investment", accountType: "ira", accountName: "ROTH IRA (3579)", accountId: 10, postedAt: day("2025-07-30") };
    const kept = retirementContributions([
      { ...base, id: 333, amountCents: -300000, merchantRaw: "Cash Contribution Current Year", categoryName: "Taxes", categoryKind: "expense" },
      { ...base, id: 578, amountCents: 300000, merchantRaw: "Fidelity", categoryName: "Fees & Charges", categoryKind: "expense" },
      { ...base, id: 579, amountCents: 300000 },
      { ...base, id: 700, amountCents: 10000, postedAt: day("2025-08-13") },
      { ...base, id: 701, amountCents: 10000, postedAt: day("2025-08-13") },
      { ...base, id: 800, amountCents: 5000, accountType: "brokerage", accountName: "Robinhood individual" },
    ]);
    expect(kept.map((r) => r.id)).toEqual([579, 700, 701]);
  });
});
