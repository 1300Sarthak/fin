import { describe, expect, test } from "bun:test";
import { buildReport, type Raw } from "./burn-core";

let nextId = 1;
const row = (p: Partial<Raw> & { amountCents: number; postedAt: string }): Raw => ({
  id: nextId++,
  accountId: 1,
  merchantRaw: "",
  isTransfer: false,
  isRefund: false,
  isExcluded: false,
  account: "Checking",
  accountType: "checking",
  isAsset: true,
  category: null,
  categoryKind: null,
  ...p,
  postedAt: new Date(`${p.postedAt}T12:00:00Z`),
});

const JUNE = [new Date("2026-06-01T00:00:00Z"), new Date("2026-06-30T23:59:59Z")] as const;
const report = (rows: Raw[]) => buildReport(rows, JUNE[0], JUNE[1], "2026-06");
const kindOf = (rows: Raw[], id: number) => report(rows).rows.find((r) => r.id === id)?.kind;

describe("burn engine", () => {
  test("a contribution with no funding leg is income that skipped the bank", () => {
    // Some brokerages book an incoming Roth contribution as a negative row.
    const rows = [
      row({ postedAt: "2026-06-15", amountCents: -300000, accountId: 9, account: "ROTH IRA", accountType: "ira", merchantRaw: "Cash Contribution Current Year", category: "Taxes", categoryKind: "expense" }),
    ];
    const r = report(rows);
    expect(r.rows[0].kind).toBe("contribution");
    expect(r.total.contributionCents).toBe(300000);
    expect(r.total.takeHomeCents).toBe(300000);
    expect(r.total.grossSpendCents).toBe(0);
  });

  test("a contribution funded from a tracked account is internal, not new income", () => {
    const rows = [
      row({ postedAt: "2026-06-07", amountCents: -350000, merchantRaw: "Brokerage transfer" }),
      row({ postedAt: "2026-06-07", amountCents: 350000, accountId: 6, account: "Brokerage", accountType: "brokerage", merchantRaw: "Brokerage transfer" }),
    ];
    const r = report(rows);
    expect(r.rows.every((x) => x.kind === "internal")).toBe(true);
    expect(r.total.takeHomeCents).toBe(0);
    expect(r.total.grossSpendCents).toBe(0);
  });

  test("401(k) money is counted as earned but kept out of take-home", () => {
    const rows = [
      row({ postedAt: "2026-06-14", amountCents: -50000, accountId: 11, account: "ACME 401(K) PLAN", accountType: "brokerage", merchantRaw: "Contribution" }),
    ];
    const r = report(rows);
    expect(r.rows[0].kind).toBe("pretax");
    expect(r.total.takeHomeCents).toBe(0);
    expect(r.total.earnedCents).toBe(50000);
  });

  test("a P2P payment out stays spending even when an equal amount arrives elsewhere", () => {
    // Without the person-to-person guard these would cancel each other out.
    const out = row({ postedAt: "2026-06-08", amountCents: -1800, merchantRaw: "Zelle Transfer to A Friend", category: "Account Transfer", categoryKind: "transfer" });
    const inbound = row({ postedAt: "2026-06-09", amountCents: 1800, accountId: 2, account: "Savings", accountType: "savings", merchantRaw: "Transfer From Checking", category: "Account Transfer", categoryKind: "transfer" });
    const r = report([out, inbound]);
    expect(r.rows.find((x) => x.id === out.id)?.kind).toBe("spend");
    expect(r.total.grossSpendCents).toBe(1800);
  });

  test("money paid back over a P2P rail nets against spending, not into income", () => {
    const rows = [row({ postedAt: "2026-06-19", amountCents: 2100, merchantRaw: "Zelle Transfer from A Friend" })];
    const r = report(rows);
    expect(r.rows[0].kind).toBe("reimbursement");
    expect(r.total.incomeCents).toBe(0);
    expect(r.total.netSpendCents).toBe(-2100);
  });

  test("dividend reinvestment inside an account nets to nothing", () => {
    const rows = [
      row({ postedAt: "2026-06-30", amountCents: 833, accountId: 9, account: "ROTH IRA", accountType: "ira", merchantRaw: "Dividend", category: "Fees & Charges", categoryKind: "expense" }),
      row({ postedAt: "2026-06-30", amountCents: -833, accountId: 9, account: "ROTH IRA", accountType: "ira", merchantRaw: "Brokerage", category: "Fees & Charges", categoryKind: "expense" }),
    ];
    const r = report(rows);
    expect(r.rows.every((x) => x.kind === "market")).toBe(true);
    expect(r.total.grossSpendCents).toBe(0);
    expect(r.total.incomeCents).toBe(0);
  });

  test("a card swipe on a brokerage account is real spending, not a trade", () => {
    const rows = [
      row({ postedAt: "2026-06-12", amountCents: -12000, accountId: 6, account: "Brokerage", accountType: "brokerage", merchantRaw: "Cinema", category: "Entertainment", categoryKind: "expense" }),
      row({ postedAt: "2026-06-15", amountCents: -16500, accountId: 6, account: "Brokerage", accountType: "brokerage", merchantRaw: "Buy Shares of Private Co", category: "Investments", categoryKind: "investment" }),
    ];
    const r = report(rows);
    expect(kindOf(rows, rows[0].id)).toBe("spend");
    expect(kindOf(rows, rows[1].id)).toBe("market");
    expect(r.total.grossSpendCents).toBe(12000);
  });

  test("a credit on a card is a refund, but cashback is income", () => {
    const rows = [
      row({ postedAt: "2026-06-13", amountCents: 100, accountId: 3, account: "Card", accountType: "credit", isAsset: false, merchantRaw: "LinkedIn", category: "Subscriptions", categoryKind: "expense" }),
      row({ postedAt: "2026-06-08", amountCents: 1254, accountId: 3, account: "Card", accountType: "credit", isAsset: false, merchantRaw: "Cashback Bonus", category: "Income", categoryKind: "income" }),
    ];
    const r = report(rows);
    expect(kindOf(rows, rows[0].id)).toBe("refund");
    expect(kindOf(rows, rows[1].id)).toBe("income");
    expect(r.total.incomeCents).toBe(1254);
  });

  test("an excluded row affects nothing", () => {
    const rows = [row({ postedAt: "2026-06-18", amountCents: -300000, merchantRaw: "Check #1001", isExcluded: true })];
    const r = report(rows);
    expect(r.rows[0].kind).toBe("excluded");
    expect(r.total.grossSpendCents).toBe(0);
  });

  // Shapes copied from the Fidelity ledger: each deposit arrives as a negative
  // "Cash Contribution Current Year" and a positive "Current Year Contribution",
  // plus a bare "Fidelity" leg that sweeps the cash into the money-market core.
  const roth = { accountId: 10, account: "ROTH IRA (3579)", accountType: "ira" } as const;
  const k401 = { accountId: 11, account: "ACME CORP 401(K) PLAN (9012)", accountType: "ira" } as const;
  const hsa = { accountId: 24, account: "Health Savings Account (3456)", accountType: "hsa" } as const;

  test("a contribution Fidelity books twice is counted once, beside its sweep leg", () => {
    const rows = [
      row({ ...roth, postedAt: "2026-06-30", amountCents: -300000, merchantRaw: "Cash Contribution Current Year", category: "Taxes", categoryKind: "expense" }),
      row({ ...roth, postedAt: "2026-06-30", amountCents: 300000, merchantRaw: "Fidelity", category: "Fees & Charges", categoryKind: "expense" }),
      row({ ...roth, postedAt: "2026-06-30", amountCents: 300000, merchantRaw: "Current Year Contribution", category: "Investments", categoryKind: "investment" }),
    ];
    const r = report(rows);
    expect(r.rows.map((x) => x.kind)).toEqual(["market", "market", "contribution"]);
    expect(r.rows[0].pairedWith).toBe(rows[2].id);
    expect(r.total.contributionCents).toBe(300000);
    expect(r.total.grossSpendCents).toBe(0);
    expect(r.total.incomeCents).toBe(0);
  });

  test("a 401(k) deferral reported as a same-day +/- pair is counted once, not netted away", () => {
    const rows = [
      row({ ...k401, postedAt: "2026-06-14", amountCents: -50000, merchantRaw: "Contribution", category: "Investments", categoryKind: "investment" }),
      row({ ...k401, postedAt: "2026-06-14", amountCents: 50000, merchantRaw: "Contribution", category: "Investments", categoryKind: "investment" }),
    ];
    const r = report(rows);
    expect(kindOf(rows, rows[1].id)).toBe("pretax");
    expect(r.total.pretaxCents).toBe(50000);
    expect(r.total.earnedCents).toBe(50000);
  });

  test("two real same-day deposits of the same size are both counted", () => {
    const rows = [
      row({ ...roth, postedAt: "2026-06-13", amountCents: 290000, merchantRaw: "Current Year Contribution", category: "Investments", categoryKind: "investment" }),
      row({ ...roth, postedAt: "2026-06-13", amountCents: 290000, merchantRaw: "Current Year Contribution", category: "Investments", categoryKind: "investment" }),
    ];
    expect(report(rows).total.contributionCents).toBe(580000);
  });

  test("the redundant leg cannot steal the funding leg its twin needs", () => {
    // Funded from savings: everything is internal, nothing is new income.
    const rows = [
      row({ ...roth, postedAt: "2026-06-09", amountCents: -140000, merchantRaw: "Cash Contribution Current Year", category: "Taxes", categoryKind: "expense" }),
      row({ ...roth, postedAt: "2026-06-09", amountCents: 140000, merchantRaw: "Current Year Contribution", category: "Investments", categoryKind: "investment" }),
      row({ postedAt: "2026-06-09", amountCents: -140000, accountId: 12, account: "Savings", accountType: "savings", merchantRaw: "Fidelity Brokerage Services", category: "Brokerage", categoryKind: "investment" }),
    ];
    const r = report(rows);
    expect(r.rows.map((x) => x.kind)).toEqual(["market", "internal", "internal"]);
    expect(r.total.takeHomeCents).toBe(0);
    expect(r.total.grossSpendCents).toBe(0);
  });

  test("an HSA contribution survives its same-day sweep, and HSA sweeps are not income or spending", () => {
    const rows = [
      row({ ...hsa, postedAt: "2026-06-29", amountCents: -59000, merchantRaw: "Fidelity", category: "Fees & Charges", categoryKind: "expense" }),
      row({ ...hsa, postedAt: "2026-06-29", amountCents: 59000, merchantRaw: "HSA Contribution", category: "Investments", categoryKind: "investment" }),
      row({ ...hsa, postedAt: "2026-06-10", amountCents: 9955, merchantRaw: "Fidelity", category: "Fees & Charges", categoryKind: "expense" }),
      row({ ...hsa, postedAt: "2026-06-09", amountCents: -9955, merchantRaw: "Investment Buy", category: "Investments", categoryKind: "investment" }),
    ];
    const r = report(rows);
    expect(r.rows.map((x) => x.kind)).toEqual(["market", "contribution", "market", "market"]);
    expect(r.total.contributionCents).toBe(59000);
    expect(r.total.incomeCents).toBe(0);
    expect(r.total.grossSpendCents).toBe(0);
  });

  test("a cash-management money-market sweep is internal, not a fee", () => {
    const cma = { accountId: 23, account: "Cash Management (Individual) (6420)", accountType: "checking" } as const;
    const rows = [
      row({ ...cma, postedAt: "2026-06-09", amountCents: -20000, merchantRaw: "Fidelity", category: "Fees & Charges", categoryKind: "expense" }),
      row({ ...cma, postedAt: "2026-06-30", amountCents: -39, merchantRaw: "Fidelity", category: "Fees & Charges", categoryKind: "expense" }),
      row({ ...cma, postedAt: "2026-06-30", amountCents: -500, merchantRaw: "Monthly maintenance fee", category: "Fees & Charges", categoryKind: "expense" }),
    ];
    const r = report(rows);
    expect(r.rows.map((x) => x.kind)).toEqual(["internal", "internal", "spend"]);
    expect(r.total.grossSpendCents).toBe(500);
  });

  test("burn and savings rate are complements of take-home", () => {
    const rows = [
      row({ postedAt: "2026-06-02", amountCents: 400000, merchantRaw: "Payroll", category: "Paycheck", categoryKind: "income" }),
      row({ postedAt: "2026-06-10", amountCents: -100000, merchantRaw: "Rent" }),
    ];
    const r = report(rows);
    expect(r.total.burnPct).toBeCloseTo(25, 6);
    expect(r.total.savingsRatePct).toBeCloseTo(75, 6);
    expect(r.total.savedCents).toBe(300000);
  });
});
