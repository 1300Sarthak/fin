import { z } from "zod";

const money = z.number().finite().min(0).max(100_000_000);
export const taxProfileSchema = z.object({
  year: z.literal(2026).default(2026),
  filingStatus: z.enum(["single", "joint", "head", "separate"]).default("single"),
  wagesBox1: money.default(0),
  withholdingBox2: money.default(0),
  otherOrdinaryIncome: money.default(0),
  confirmedAdjustments: money.default(0),
  confirmedItemizedDeductions: money.default(0),
  eligibleCashDonations: money.default(0),
  retirementContributions: money.default(0),
  hasSelfEmployment: z.boolean().default(false),
  hasDependents: z.boolean().default(false),
  hasEducationExpenses: z.boolean().default(false),
  hasHsa: z.boolean().default(false),
  spouseItemizes: z.boolean().default(false),
  specialStandardDeduction: z.boolean().default(false),
});
export type TaxProfile = z.infer<typeof taxProfileSchema>;

export const planningProfileSchema = z.object({
  monthlyTakeHome: money.default(0),
  monthlyEssentials: money.default(0),
  monthlyFlexible: money.default(0),
  monthlyDebtPayments: money.default(0),
  monthlyInvesting: money.default(0),
  emergencyMonths: z.number().int().min(1).max(24).default(6),
  goalName: z.string().trim().max(120).default(""),
  goalTarget: money.default(0),
  goalSaved: money.default(0),
  goalMonths: z.number().int().min(1).max(600).default(12),
  notes: z.string().trim().max(4000).default(""),
  shareWithAgent: z.boolean().default(false),
  tax: taxProfileSchema.default(() => taxProfileSchema.parse({})),
});
export type PlanningProfile = z.infer<typeof planningProfileSchema>;

export function calculateFinancialPlan(profile: PlanningProfile, liquidAssetsCents = 0) {
  const p = planningProfileSchema.parse(profile);
  const committed = p.monthlyEssentials + p.monthlyFlexible + p.monthlyDebtPayments + p.monthlyInvesting;
  const remaining = p.monthlyTakeHome - committed;
  const reserveTarget = (p.monthlyEssentials + p.monthlyDebtPayments) * p.emergencyMonths;
  const reserveGap = Math.max(0, reserveTarget - liquidAssetsCents / 100);
  const goalGap = Math.max(0, p.goalTarget - p.goalSaved);
  return {
    monthlyCommitted: committed,
    monthlyRemaining: remaining,
    annualPlannedInvesting: p.monthlyInvesting * 12,
    reserveTarget,
    reserveGap,
    reserveMonths: p.monthlyEssentials + p.monthlyDebtPayments > 0 ? liquidAssetsCents / 100 / (p.monthlyEssentials + p.monthlyDebtPayments) : null,
    goalGap,
    goalMonthlyNeeded: goalGap / p.goalMonths,
    goalAffordable: remaining >= goalGap / p.goalMonths,
    monthsToReserve: reserveGap === 0 ? 0 : remaining > 0 ? Math.ceil(reserveGap / remaining) : null,
    assumptions: ["All inputs are monthly USD except goal amounts and tax fields.", "Reserve and goal projections use the same unallocated cash; funding both requires splitting it.", "No investment growth, inflation, or tax refund is assumed."],
  };
}
