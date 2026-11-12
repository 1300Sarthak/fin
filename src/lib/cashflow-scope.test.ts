/**
 * One definition of "outside spendable cash flow" (investment-type accounts,
 * HSA included, and money-market sweeps), checked at every consumer, plus the
 * Overview / History / Spending agreement and the cash balance rebuilt from
 * its rows. Fixture rows are dated 2025-10 and removed afterwards, because test
 * files share one database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, gt, inArray, sql } from "drizzle-orm";
import { db, schema } from "./assistant/test-db";
import { INVESTMENT_ACCOUNT_TYPES, isCashSweep, isInvestmentAccountType, sweepTextSql } from "./cashflow-scope";
import { isSweepText } from "./investment-activity";

// Loaded after test-db has pointed DATABASE_URL at the temp file.
const { getCashflow, monthRange } = await import("@/lib/spending");
const { daySpan } = await import("@/lib/spending-summary");
const { getNetWorthSummary, cashflowAccountIds } = await import("@/lib/networth");
const { getPeriodHistory } = await import("@/lib/history");
const { getSpendableBalanceCents } = await import("@/lib/forecast");
const { getSpendableAccounts } = await import("@/lib/queries");
const { findRefundCandidates } = await import("@/lib/refunds");
const { getSpendingAnomalies } = await import("@/lib/anomalies");
const { proposeSplit } = await import("@/lib/assistant/changes");
const { applyCashOp, getCashAccount, getCashDrift } = await import("@/lib/cash");
const { setHideCash } = await import("@/lib/config");

const { accounts, categories, transactions, balanceSnapshots } = schema;
const day = (d: string) => new Date(`${d}T12:00:00Z`);
const made = { accounts: [] as number[], categories: [] as number[], txns: [] as number[] };
let snapshotsBefore = 0;
let hsaId = 0;
let cmaId = 0;
let sweepOut = 0;
let sweepIn = 0;
let hsaIn = 0;
let bankId = 0;

beforeAll(async () => {
  snapshotsBefore = (await db.select({ id: balanceSnapshots.id }).from(balanceSnapshots)).reduce((m, r) => Math.max(m, r.id), 0);
  const [fees, invest] = await db.insert(categories).values([
    { name: "Fees & Charges (scope test)", kind: "expense" },
    { name: "Investments (scope test)", kind: "investment" },
  ]).returning();
  made.categories.push(fees.id, invest.id);
  const [cma, hsa, bank, roth] = await db.insert(accounts).values([
    { name: "Cash Management (Individual) (scope test)", type: "checking", source: "manual", currentBalanceCents: 20000 },
    { name: "Health Savings Account (scope test)", type: "hsa", source: "manual", currentBalanceCents: 69000 },
    { name: "Bank of America checking (scope test)", type: "checking", source: "manual", currentBalanceCents: 5000 },
    { name: "ROTH IRA (scope test)", type: "ira", source: "manual", currentBalanceCents: 100000 },
  ]).returning();
  made.accounts.push(cma.id, hsa.id, bank.id, roth.id);
  cmaId = cma.id;
  hsaId = hsa.id;
  bankId = bank.id;
  // Earlier "Fidelity" charges give the sweep a merchant history, so an
  // unscoped detector would flag the October one as a spike.
  const rows = await db.insert(transactions).values([
    ...["2025-05-30", "2025-06-30", "2025-07-30", "2025-08-29"].map((d) => ({ accountId: cma.id, postedAt: day(d), amountCents: -40, merchantRaw: "Fidelity", payeeNormalized: "fidelity", categoryId: fees.id })),
    { accountId: cma.id, postedAt: day("2025-10-29"), amountCents: -59000, merchantRaw: "Fidelity", payeeNormalized: "fidelity", categoryId: fees.id },
    { accountId: cma.id, postedAt: day("2025-10-30"), amountCents: 59000, merchantRaw: "Fidelity", payeeNormalized: "fidelity", categoryId: fees.id },
    { accountId: hsa.id, postedAt: day("2025-10-29"), amountCents: 59000, merchantRaw: "HSA Contribution", payeeNormalized: "hsa contribution", categoryId: invest.id },
    { accountId: hsa.id, postedAt: day("2025-10-29"), amountCents: -12000, merchantRaw: "Pharmacy", payeeNormalized: "pharmacy", categoryId: fees.id },
    // An ordinary bank's bare "FIDELITY" debit is a payment, not a sweep.
    { accountId: bank.id, postedAt: day("2025-10-15"), amountCents: -5000, merchantRaw: "FIDELITY", payeeNormalized: "fidelity", categoryId: fees.id },
    // A Roth deposit funded from a tracked bank, so flagged as a transfer.
    { accountId: roth.id, postedAt: day("2025-11-03"), amountCents: 25000, merchantRaw: "Current Year Contribution", payeeNormalized: "current year contribution", categoryId: invest.id, isTransfer: true },
  ]).returning();
  made.txns.push(...rows.map((r) => r.id));
  [sweepOut, sweepIn, hsaIn] = [rows[4].id, rows[5].id, rows[6].id];
});

afterAll(async () => {
  await setHideCash(false);
  await db.delete(transactions).where(inArray(transactions.id, made.txns));
  await db.delete(balanceSnapshots).where(gt(balanceSnapshots.id, snapshotsBefore));
  await db.delete(accounts).where(inArray(accounts.id, made.accounts));
  await db.delete(categories).where(inArray(categories.id, made.categories));
});

describe("the shared scope", () => {
  test("HSA is an investment-type account", () => {
    expect(INVESTMENT_ACCOUNT_TYPES).toContain("hsa");
    expect(["hsa", "ira", "brokerage", "crypto"].every(isInvestmentAccountType)).toBe(true);
    expect(["checking", "savings", "cash", "credit"].some(isInvestmentAccountType)).toBe(false);
  });

  // [descriptor, is it a sweep]. Whitespace, case and near-miss edges.
  const SWEEP_CASES: [string, boolean][] = [
    ["Fidelity", true], [" FIDELITY ", true], ["Fidelity\n", true], ["Fidelity\t", true], ["\tFIDELITY\r\n", true], ["Fid elity", true], ["Fidelity\v", true],
    ["Realizedgainloss", true], ["Realized Gain Loss", true], ["Realized  Gain Loss", true], ["REALIZED GAIN/LOSS", true],
    ["Purchase into Fidelity Government Money Market", true], ["FIDELITY GOVT MONEY MARKET", true], ["Redemption from Fidelity Government Money Market (SPAXX)", true],
    ["unrealized gain loss", false], ["Realized gain loss on AAPL", false], ["Blue Money Market Cafe", false], ["Money Market", false],
    ["Fidelity Investments", false], ["Fidelity Brokerage Services", false], ["Monthly maintenance fee", false], ["", false],
    ["Fidelity\u00a0", false], ["FİDELITY", false], ["Fidelity Money Mar\u212Aet", false],
  ];

  test("the sweep text rule matches Fidelity's phrasings and rejects near misses", () => {
    expect(SWEEP_CASES.filter(([text, want]) => isSweepText(text) !== want)).toEqual([]);
  });

  test("the SQL twin agrees with the JS rule on every edge, on the real database", async () => {
    const disagree: string[] = [];
    for (const [text] of SWEEP_CASES) {
      const row = await db.get<{ v: number }>(sql`SELECT ${sweepTextSql(sql`${text}`)} AS v`);
      if (Boolean(row.v) !== isSweepText(text)) disagree.push(JSON.stringify(text));
    }
    expect(disagree).toEqual([]);
  });

  test("the sweep rule applies only on accounts with a money-market core", () => {
    const row = (accountType: string, accountName: string) => ({ merchantRaw: "Fidelity", accountType, accountName });
    expect(isCashSweep(row("checking", "Cash Management (Individual) (6420)"))).toBe(true);
    expect(isCashSweep(row("hsa", "Health Savings Account (3456)"))).toBe(true);
    expect(isCashSweep(row("ira", "ROTH IRA (3579)"))).toBe(true);
    expect(isCashSweep(row("checking", "7Tamsin (4321)"))).toBe(false);
    expect(isCashSweep(row("credit", "Chase Freedom Unlimited (1357)"))).toBe(false);
  });

  test("spending leaves out the HSA and the sweep in both directions, but not a bank's FIDELITY debit", async () => {
    const flow = await getCashflow(monthRange("2025-10"), [cmaId, hsaId]);
    expect(flow).toEqual({ incomeCents: 0, spendingCents: 0, refundCents: 0, net: 0 });
    expect((await getCashflow(monthRange("2025-10"), [bankId])).spendingCents).toBe(5000);
  });

  test("spendable cash and the spending picker leave out the HSA", async () => {
    expect((await getSpendableAccounts()).map((a) => a.id)).toContain(cmaId);
    expect((await getSpendableAccounts()).map((a) => a.id)).not.toContain(hsaId);
    const before = await getSpendableBalanceCents();
    await db.update(accounts).set({ currentBalanceCents: 1_000_000 }).where(eq(accounts.id, hsaId));
    expect(await getSpendableBalanceCents()).toBe(before);
  });

  test("a sweep or an HSA deposit is never a refund candidate", async () => {
    const ids = (await findRefundCandidates()).map((c) => c.id);
    expect(ids).not.toContain(sweepIn);
    expect(ids).not.toContain(hsaIn);
  });

  test("anomalies never flag a sweep", async () => {
    const flagged = await getSpendingAnomalies("2025-10");
    expect(flagged.filter((a) => /fidelity|fees & charges \(scope/i.test(`${a.title} ${a.detail}`))).toEqual([]);
  });

  test("a sweep cannot be split", async () => {
    await expect(proposeSplit(sweepOut, 100)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("Overview and History use the Spending page's numbers", () => {
  test("Overview Made/Spent equal getCashflow over the same days", async () => {
    for (const range of ["1M", "1Y", "MAX"] as const) {
      const s = await getNetWorthSummary({ range });
      const today = new Date().toLocaleDateString("en-CA");
      const flow = await getCashflow(daySpan(s.startDate, today));
      expect([s.rangeIncomeCents, s.rangeSpendingCents]).toEqual([flow.incomeCents, flow.spendingCents]);
    }
  });

  test("History per month equals getCashflow for that month", async () => {
    const oct = (await getPeriodHistory("month")).find((r) => r.key === "2025-10");
    const flow = await getCashflow(monthRange("2025-10"));
    expect([oct?.incomeCents, oct?.spendingCents]).toEqual([flow.incomeCents, flow.spendingCents]);
  });

  test("a narrowed account selection scopes the cash flow; the full one, or one hidden by a setting, does not", () => {
    expect(cashflowAccountIds(new Set([1, 2, 3]), [1, 2, 3])).toBeUndefined();
    expect(cashflowAccountIds(new Set([1, 3]), [1, 2, 3])).toEqual([1, 3]);
    expect(cashflowAccountIds(new Set([1, 3]), [1, 2, 3], new Set([2]))).toBeUndefined();
  });

  test("Overview and History count the same retirement deposits, including one flagged as a transfer", async () => {
    const s = await getNetWorthSummary({ range: "MAX" });
    const rows = await getPeriodHistory("month");
    expect(rows.find((r) => r.key === "2025-11")?.retirementContributionCents).toBe(25000);
    const inRange = rows.filter((r) => r.end >= s.startDate).reduce((sum, r) => sum + r.retirementContributionCents, 0);
    expect(s.rangeRetirementContributionCents).toBe(inRange);
  });
});

describe("cash on hand comes from its rows", () => {
  test("a stale stored balance is reported, then healed by the next entry", async () => {
    const existed = await getCashAccount();
    const first = await applyCashOp("add", 50000, "scope test float", day("2025-10-01"));
    const cash = (await getCashAccount())!;
    const rowsAtStart = first.balanceCents;
    // Simulate the drift seen in the real ledger: stored 0, rows say otherwise.
    await db.update(accounts).set({ currentBalanceCents: 0 }).where(eq(accounts.id, cash.id));
    expect(await getCashDrift()).toEqual({ storedCents: 0, fromRowsCents: rowsAtStart, reconciled: false });

    // The old code subtracted from the stale 0, clamped, and wrote no row.
    const spent = await applyCashOp("subtract", 1700, "scope test lunch", day("2025-10-02"));
    expect(spent.balanceCents).toBe(rowsAtStart - 1700);
    expect(spent.deltaCents).toBe(-1700);
    expect(await getCashDrift()).toEqual({ storedCents: rowsAtStart - 1700, fromRowsCents: rowsAtStart - 1700, reconciled: true });

    if (!existed) made.accounts.push(cash.id);
  });

  test("a negative row sum is reported, not hidden behind the stored $0, and a set lands exactly", async () => {
    const cash = (await getCashAccount())!;
    const before = (await getCashDrift())!.fromRowsCents;
    await db.insert(transactions).values({ accountId: cash.id, postedAt: day("2025-10-03"), amountCents: -(before + 900), merchantRaw: "scope test overspend", source: "manual" });
    const drift = await getCashDrift();
    expect(drift).toMatchObject({ fromRowsCents: -900, reconciled: false });
    const set = await applyCashOp("set", 1000, "scope test recount", day("2025-10-04"));
    expect(set.balanceCents).toBe(1000);
    expect(await getCashDrift()).toEqual({ storedCents: 1000, fromRowsCents: 1000, reconciled: true });
  });

  test("two concurrent spends never both draw on the same balance", async () => {
    // $10 on hand; two $8 spends at once. Serialized: -$8 then -$2, never -$16.
    const results = await Promise.all([
      applyCashOp("subtract", 800, "scope test race a", day("2025-10-05")),
      applyCashOp("subtract", 800, "scope test race b", day("2025-10-05")),
    ]);
    expect(results.map((r) => r.deltaCents).sort((a, b) => a - b)).toEqual([-800, -200]);
    expect(await getCashDrift()).toEqual({ storedCents: 0, fromRowsCents: 0, reconciled: true });
  });

  test("hiding cash from net worth does not drop cash spending from Overview", async () => {
    await setHideCash(true);
    try {
      const s = await getNetWorthSummary({ range: "MAX" });
      const flow = await getCashflow(daySpan(s.startDate, new Date().toLocaleDateString("en-CA")));
      expect([s.rangeIncomeCents, s.rangeSpendingCents]).toEqual([flow.incomeCents, flow.spendingCents]);
    } finally {
      await setHideCash(false);
    }
  });

  afterAll(async () => {
    const mine = await db.select({ id: transactions.id }).from(transactions).where(sql`${transactions.merchantRaw} LIKE 'scope test %'`);
    made.txns.push(...mine.map((r) => r.id));
  });
});
