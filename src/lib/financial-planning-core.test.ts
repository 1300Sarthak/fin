import { describe, expect, test } from "bun:test";
import { calculateFinancialPlan, planningProfileSchema, taxProfileSchema } from "./financial-planning-core";
import { calculateTaxPlan, ordinaryFederalTax } from "./tax-planning";

describe("financial planning", () => {
  test("allocates take-home once and includes minimum debt service in reserves", () => {
    const profile = planningProfileSchema.parse({ monthlyTakeHome: 5000, monthlyEssentials: 2000, monthlyFlexible: 500, monthlyDebtPayments: 300, monthlyInvesting: 700, goalTarget: 12000, goalSaved: 2000, goalMonths: 10 });
    const result = calculateFinancialPlan(profile, 500_000);
    expect(result.monthlyRemaining).toBe(1500);
    expect(result.reserveTarget).toBe(13800);
    expect(result.reserveGap).toBe(8800);
    expect(result.goalMonthlyNeeded).toBe(1000);
    expect(result.goalAffordable).toBe(true);
    expect(result.monthsToReserve).toBe(6);
  });
  test("does not invent a funding date for negative cash flow", () => {
    const result = calculateFinancialPlan(planningProfileSchema.parse({ monthlyTakeHome: 1000, monthlyEssentials: 1200 }));
    expect(result.monthlyRemaining).toBe(-200);
    expect(result.monthsToReserve).toBeNull();
  });
  test("starts without personal assumptions and rejects invalid inputs", () => {
    const profile = planningProfileSchema.parse({});
    expect(profile.monthlyTakeHome).toBe(0);
    expect(profile.notes).toBe("");
    expect(profile.shareWithAgent).toBe(false);
    expect(() => planningProfileSchema.parse({ monthlyTakeHome: -1 })).toThrow();
    expect(() => taxProfileSchema.parse({ year: 2025 })).toThrow();
  });
});

describe("2026 federal ordinary income illustration", () => {
  test("uses progressive brackets, not marginal rate on all income", () => {
    expect(ordinaryFederalTax(50_400, "single").tax).toBe(5800);
    expect(ordinaryFederalTax(100_800, "joint").tax).toBe(11600);
    expect(ordinaryFederalTax(67_450, "head").tax).toBe(7740);
    expect(ordinaryFederalTax(105_700, "separate").tax).toBe(17966);
  });
  test("does not subtract 401k deferrals twice from W2 Box 1", () => {
    const result = calculateTaxPlan(taxProfileSchema.parse({ wagesBox1: 50_000, retirementContributions: 20_000 }));
    expect(result.agi).toBe(50_000);
    expect(result.taxableIncome).toBe(33_900);
    expect(result.ordinaryIncomeTaxBeforeCredits).toBe(3820);
    expect(result.baseRetirementRoom).toBe(4500);
  });
  test("compares standard plus eligible gifts against confirmed itemizing without double counting", () => {
    const standard = calculateTaxPlan(taxProfileSchema.parse({ wagesBox1: 100_000, eligibleCashDonations: 5000, confirmedItemizedDeductions: 17_000 }));
    expect(standard.deductionMethod).toBe("standard");
    expect(standard.deduction).toBe(17_100);
    const itemized = calculateTaxPlan(taxProfileSchema.parse({ wagesBox1: 100_000, eligibleCashDonations: 5000, confirmedItemizedDeductions: 20_000 }));
    expect(itemized.deduction).toBe(20_000);
  });
  test("separate filer cannot take a standard deduction when spouse itemizes", () => {
    const result = calculateTaxPlan(taxProfileSchema.parse({ wagesBox1: 50_000, filingStatus: "separate", spouseItemizes: true, eligibleCashDonations: 1000 }));
    expect(result.standardDeduction).toBe(0);
    expect(result.deduction).toBe(0);
    expect(result.deductionMethod).toBe("itemized");
  });
  test("suppresses estimates where supported assumptions fail", () => {
    for (const flags of [{ hasSelfEmployment: true }, { specialStandardDeduction: true }, { wagesBox1: 600_000 }, { wagesBox1: 10, confirmedAdjustments: 11 }]) {
      const result = calculateTaxPlan(taxProfileSchema.parse(flags));
      expect(result.ordinaryIncomeTaxBeforeCredits).toBeNull();
      expect(result.unsupportedReasons.length).toBeGreaterThan(0);
    }
  });
  test("dependent and education credits are identified but never fabricated", () => {
    const result = calculateTaxPlan(taxProfileSchema.parse({ hasDependents: true, hasEducationExpenses: true }));
    expect(result.opportunities.some(item => item.kind === "credit")).toBe(true);
    expect(result.ordinaryIncomeTaxBeforeCredits).toBe(0);
    expect(result).not.toHaveProperty("refund");
  });
});
