import { describe, expect, test } from "bun:test";
import {
  annualWindow, contributionDeadline, count401k, countAnnualContributions, findLoanPayments, isStudentLoanInterestGoal,
  limitForGoal, monthIndex, plan401k, planWindow, type ContributionEvent,
} from "./goals-core";
import { limitFor, studentLoanInterestDeduction } from "./contribution-limits";
import { simulateWaterfall } from "./planner-core";
import { computeTakeHome } from "./take-home";

let id = 1;
const ev = (accountType: string, account: string, date: string, amountCents: number, description: string, internal = false): ContributionEvent =>
  ({ txnId: id++, date, accountId: accountType === "hsa" ? 24 : /401/.test(account) ? 11 : 10, account, accountType, amountCents, description, internal });
const ROTH = "ROTH IRA (3579)", K401 = "ACME CORP 401(K) PLAN (9012)", HSA = "Health Savings Account (7788)";

// The real 2026 ledger shape: Fidelity books each contribution twice (the
// negative leg is already marked internal by investment-history), a prior-year
// contribution in April, and a sweep leg in the HSA.
const LEDGER: ContributionEvent[] = [
  ev("ira", ROTH, "2026-04-13", 300_000, "Cash Contribution Prior Year"),
  ev("ira", ROTH, "2026-07-30", 319_678, "Current Year Contribution"),
  ev("ira", ROTH, "2026-07-30", 319_678, "Cash Contribution Current Year", true),
  ev("ira", ROTH, "2026-08-13", 289_865, "Current Year Contribution"),
  ev("ira", ROTH, "2026-09-09", 140_457, "Current Year Contribution"),
  ev("ira", K401, "2026-08-14", 50_755, "Contribution"),
  ev("ira", K401, "2026-08-14", 50_755, "Contribution", true),
  ev("ira", K401, "2026-08-31", 23_071, "Contribution"),
  ev("ira", K401, "2026-11-02", 243_800, "Contribution"),
  ev("hsa", HSA, "2026-09-09", 10_000, "Partic Contr Current Contrb"),
  ev("hsa", HSA, "2026-10-29", 59_288, "HSA Contribution"),
  ev("hsa", HSA, "2026-10-29", 59_288, "Fidelity", true),
];

describe("roth_ira", () => {
  test("counts 2026 current-year contributions once and leaves the prior-year one out", () => {
    const r = countAnnualContributions(LEDGER, "roth_ira", 2026);
    expect(r.cents).toBe(750_000);
    expect(r.rows).toHaveLength(3);
    expect(r.otherYearCents).toBe(300_000);
  });
  test("the April prior-year contribution counts toward 2025, and only until April 15", () => {
    expect(countAnnualContributions(LEDGER, "roth_ira", 2025).cents).toBe(300_000);
    const late = [ev("ira", ROTH, "2027-04-16", 50_000, "Cash Contribution Prior Year"), ev("ira", ROTH, "2027-03-01", 20_000, "Cash Contribution Prior Year")];
    expect(countAnnualContributions(late, "roth_ira", 2026).cents).toBe(20_000);
    expect(countAnnualContributions(late, "roth_ira", 2027).cents).toBe(0);
  });
  test("401(k) deposits never count as IRA contributions", () => {
    expect(countAnnualContributions(LEDGER, "roth_ira", 2026).rows.every((r) => r.account === ROTH)).toBe(true);
  });
});

describe("hsa", () => {
  test("counts HSA deposits, skipping the sweep leg", () => {
    expect(countAnnualContributions(LEDGER, "hsa", 2026).cents).toBe(69_288);
  });
  test("a family target reads the family limit, else self-only", () => {
    expect(limitForGoal("hsa", 2026, 875_000, false)?.kind).toBe("hsa_family");
    expect(limitForGoal("hsa", 2026, 440_000, false)?.kind).toBe("hsa_self");
    expect(limitForGoal("hsa", 2027, 900_000, false)?.cents).toBe(900_000);
  });
});

describe("k401", () => {
  test("counts employee deposits in the year, deduped", () => {
    expect(count401k(LEDGER, 2026).cents).toBe(317_626);
    expect(count401k(LEDGER, 2025).cents).toBe(0);
  });
  test("three checks left cannot reach $24,500: says so plainly", () => {
    const p = plan401k({ year: 2026, limitCents: 2_450_000, ytdCents: 317_626, postingCents: 143_473, remainingChecks: 3, perCheckGrossCents: 423_077, projectedCents: 430_419 });
    expect(p.verdict).toBe("impossible");
    expect(p.neededPerCheckCents).toBe(662_967);
    expect(p.message).toContain("more than the whole paycheck");
    expect(p.message).toContain("$5,738.92 more is on pace");
  });
  test("a reachable gap asks for a raise; at the limit is maxed; none left says so", () => {
    expect(plan401k({ year: 2026, limitCents: 100_000, ytdCents: 40_000, postingCents: 0, remainingChecks: 3, perCheckGrossCents: 400_000, projectedCents: 0 }).verdict).toBe("raise");
    expect(plan401k({ year: 2026, limitCents: 100_000, ytdCents: 40_000, postingCents: 0, remainingChecks: 1, perCheckGrossCents: 70_000, projectedCents: 0 }).verdict).toBe("stretch");
    expect(plan401k({ year: 2026, limitCents: 100_000, ytdCents: 40_000, postingCents: 0, remainingChecks: 3, perCheckGrossCents: 400_000, projectedCents: 60_000 }).verdict).toBe("on track");
    expect(plan401k({ year: 2026, limitCents: 100_000, ytdCents: 100_000, postingCents: 0, remainingChecks: 3, perCheckGrossCents: 400_000, projectedCents: 0 }).verdict).toBe("maxed");
    expect(plan401k({ year: 2026, limitCents: 100_000, ytdCents: 0, postingCents: 0, remainingChecks: 0, perCheckGrossCents: 400_000, projectedCents: 0 }).verdict).toBe("no paychecks left");
  });
});

describe("manual (student loan interest)", () => {
  test("only a manual, tax-year goal named for it feeds the tax estimate", () => {
    expect(isStudentLoanInterestGoal({ name: "Student loan interest 2026", progressKind: "manual", taxYear: 2026 })).toBe(true);
    expect(isStudentLoanInterestGoal({ name: "Student loan interest 2026", progressKind: "balance", taxYear: 2026 })).toBe(false);
    expect(isStudentLoanInterestGoal({ name: "Student loan payoff", progressKind: "manual", taxYear: 2026 })).toBe(false);
    expect(limitForGoal("manual", 2026, 250_000, true)?.cents).toBe(250_000);
    expect(limitForGoal("manual", 2026, 250_000, false)).toBeNull();
  });
  test("payments found: servicers and a large Education payment, never small ones or income", () => {
    const rows = [
      { txnId: 611, date: "2026-09-16", accountId: 12, account: "Savings", merchant: "Univ", category: "Education", amountCents: -310_000 },
      { txnId: 46, date: "2026-04-17", accountId: 1, account: "Checking", merchant: "Univ", category: "Education", amountCents: -6_000 },
      { txnId: 7, date: "2026-05-01", accountId: 1, account: "Checking", merchant: "NELNET LOAN PAYMENT", category: null, amountCents: -20_000 },
      { txnId: 8, date: "2025-05-01", accountId: 1, account: "Checking", merchant: "NELNET LOAN PAYMENT", category: null, amountCents: -20_000 },
      { txnId: 9, date: "2026-05-02", accountId: 1, account: "Checking", merchant: "Mohela refund", category: null, amountCents: 20_000 },
    ];
    expect(findLoanPayments(rows, 2026).map((r) => r.txnId)).toEqual([611, 7]);
  });
  test("deduction: capped at $2,500, phased out between $85k and $100k MAGI (2026 single)", () => {
    expect(studentLoanInterestDeduction(400_000, 5_000_000, "single", 2026).deductionCents).toBe(250_000);
    expect(studentLoanInterestDeduction(250_000, 9_250_000, "single", 2026).deductionCents).toBe(125_000);
    expect(studentLoanInterestDeduction(250_000, 10_000_000, "single", 2026).deductionCents).toBe(0);
    expect(studentLoanInterestDeduction(250_000, 18_000_000, "joint", 2026).deductionCents).toBe(208_333);
    expect(studentLoanInterestDeduction(250_000, 1, "separate", 2026).deductionCents).toBe(0);
  });
  test("take-home: interest comes off federal and California AGI and lowers tax", () => {
    const base = { filingStatus: "single" as const, w2GrossCents: 5_080_335, pretaxDeferralsCents: 891_518, seGrossCents: 0, seExpensesCents: 0, nontaxableCents: 0, federalWithheldCents: null };
    const without = computeTakeHome(base), withIt = computeTakeHome({ ...base, studentLoanInterestCents: 250_000 });
    expect(without.federal.agiCents - withIt.federal.agiCents).toBe(250_000);
    expect(without.california.agiCents - withIt.california.agiCents).toBe(250_000);
    // 12% federal + 4% California on $2,500.
    expect(without.totalTaxCents - withIt.totalTaxCents).toBe(40_000);
    expect(withIt.studentLoanInterest.magiCents).toBe(without.federal.agiCents);
  });
});

describe("limits table", () => {
  test("2026 is official; 2027 IRA and 402(g) are projected placeholders; 2027 HSA is official", () => {
    expect(limitFor("ira", 2026)).toMatchObject({ cents: 750_000, status: "official" });
    expect(limitFor("k402g", 2026)).toMatchObject({ cents: 2_450_000, status: "official" });
    expect(limitFor("hsa_family", 2026)?.cents).toBe(875_000);
    expect(limitFor("ira", 2027)).toMatchObject({ cents: 750_000, status: "projected" });
    expect(limitFor("k402g", 2027)?.status).toBe("projected");
    expect(limitFor("hsa_self", 2027)).toMatchObject({ cents: 450_000, status: "official" });
    expect(limitFor("ira", 2030)).toBeNull();
  });
});

describe("annual windows and the contribution plan", () => {
  const TODAY = "2026-11-12";
  test("deadlines: IRA/HSA the next April 15; 401(k) and interest Dec 31; balance none", () => {
    expect(contributionDeadline("roth_ira", 2026)).toBe("2027-04-15");
    expect(contributionDeadline("k401", 2026)).toBe("2026-12-31");
    expect(contributionDeadline("balance", 2026)).toBeNull();
    expect(annualWindow("roth_ira", 2027, TODAY)).toBe("upcoming");
    expect(annualWindow("roth_ira", 2026, "2027-04-16")).toBe("closed");
    expect(annualWindow("hsa", 2026, "2027-04-15")).toBe("open");
    expect(monthIndex(TODAY, "2027-01-01")).toBe(3);
  });
  test("funded, closed and payroll goals leave the plan; balance goals stay as before", () => {
    const g = (progressKind: "balance" | "roth_ira" | "hsa" | "k401" | "manual", taxYear: number | null, currentCents = 0) => ({ progressKind, taxYear, targetCents: 750_000, currentCents });
    expect(planWindow(g("balance", null), TODAY)).toEqual({ include: true });
    expect(planWindow(g("roth_ira", 2026, 750_000), TODAY)).toEqual({ include: false, why: "funded" });
    expect(planWindow(g("k401", 2026), TODAY)).toMatchObject({ include: false });
    expect(planWindow(g("hsa", 2025), TODAY)).toMatchObject({ include: false, why: "contribution window closed" });
    expect(planWindow(g("roth_ira", 2027), TODAY)).toEqual({ include: true, opensInMonths: 3, closesAfterMonths: 18 });
    expect(planWindow(g("manual", 2026), TODAY)).toEqual({ include: true, opensInMonths: undefined, closesAfterMonths: 2 });
  });
  test("the waterfall waits for an upcoming year and stops at a deadline", () => {
    const r = simulateWaterfall([
      { id: 1, name: "Interest 2026", type: "debt_payoff", priority: 0, targetCents: 250_000, currentCents: 0, closesAfterMonths: 2 },
      { id: 2, name: "Roth 2027", type: "retirement", priority: 1, targetCents: 750_000, currentCents: 0, opensInMonths: 3 },
      { id: 3, name: "Invest", type: "taxable_invest", priority: 2, targetCents: 0, currentCents: 0 },
    ], 100_000);
    const [interest, roth, invest] = r.goals;
    expect(interest.missesDeadline).toBe(true);
    expect(interest.monthsToComplete).toBeNull();
    expect(roth.monthlyAllocationCents).toBe(0); // closed to money until January
    expect(roth.monthsToComplete).toBe(10); // months 3..10 at $1k
    expect(invest.monthlyAllocationCents).toBe(0);
  });
});
