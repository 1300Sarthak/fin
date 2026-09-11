import { taxProfileSchema, type TaxProfile } from "./financial-planning-core";

export const TAX_SOURCES = [
  { title: "2026 federal brackets and standard deductions", url: "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf" },
  { title: "2026 estimated tax, SALT, and charitable deduction changes", url: "https://www.irs.gov/pub/irs-prior/p505--2026.pdf" },
  { title: "2026 retirement contribution limits", url: "https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500" },
  { title: "2026 HSA contribution limits", url: "https://www.irs.gov/irb/2025-21_IRB#REV-PROC-2025-19" },
  { title: "Employee expense exceptions", url: "https://www.irs.gov/instructions/i2106" },
  { title: "Charitable contributions", url: "https://www.irs.gov/taxtopics/tc506" },
] as const;
export const TAX_VERIFIED_AS_OF = "2026-09-09";
const STANDARD = { single: 16_100, joint: 32_200, head: 24_150, separate: 16_100 };
const BRACKETS = {
  single: [12_400, 50_400, 105_700, 201_775, 256_225, 640_600],
  joint: [24_800, 100_800, 211_400, 403_550, 512_450, 768_700],
  head: [17_700, 67_450, 105_700, 201_750, 256_200, 640_600],
  separate: [12_400, 50_400, 105_700, 201_775, 256_225, 384_350],
};
const RATES = [.10, .12, .22, .24, .32, .35, .37];
export function ordinaryFederalTax(taxable: number, status: TaxProfile["filingStatus"]) {
  let tax = 0, lower = 0, marginalRate = 0;
  for (const [index, upper] of [...BRACKETS[status], Infinity].entries()) {
    const slice = Math.max(0, Math.min(taxable, upper) - lower);
    tax += slice * RATES[index];
    if (slice > 0) marginalRate = RATES[index];
    lower = upper;
  }
  return { tax: Math.round(tax * 100) / 100, marginalRate };
}

/** A deliberately bounded ordinary-income illustration, not a return or refund calculator. */
export function calculateTaxPlan(input: TaxProfile) {
  const p = taxProfileSchema.parse(input);
  const income = p.wagesBox1 + p.otherOrdinaryIncome;
  const agi = Math.max(0, income - p.confirmedAdjustments);
  const standard = p.filingStatus === "separate" && p.spouseItemizes ? 0 : STANDARD[p.filingStatus];
  const mustItemize = p.filingStatus === "separate" && p.spouseItemizes;
  const cashDonation = mustItemize ? 0 : Math.min(p.eligibleCashDonations, p.filingStatus === "joint" ? 2_000 : 1_000);
  const useItemized = mustItemize || p.confirmedItemizedDeductions > standard + cashDonation;
  const deduction = useItemized ? p.confirmedItemizedDeductions : standard + cashDonation;
  const taxableIncome = Math.max(0, agi - deduction);
  const unsupportedReasons: string[] = [];
  if (p.specialStandardDeduction) unsupportedReasons.push("Age 65+, blindness, or being claimable as a dependent requires a different standard deduction calculation.");
  if (p.hasSelfEmployment) unsupportedReasons.push("Self-employment requires Schedule C, self-employment tax, and potentially a qualified business income deduction.");
  if (agi > 500_000) unsupportedReasons.push("High-income AMT, SALT, and itemized-deduction limitations require a full tax calculation.");
  if (p.confirmedAdjustments > income) unsupportedReasons.push("Confirmed adjustments exceed entered income; check the inputs.");
  const ordinary = ordinaryFederalTax(taxableIncome, p.filingStatus);
  const opportunities = [
    { title: "Check your W-2 first", kind: "record", detail: "Use combined Box 1 wages and Box 2 federal withholding for the full tax year. Traditional payroll 401(k) and payroll HSA deductions are normally already excluded from Box 1; never subtract them again.", source: "https://www.irs.gov/instructions/iw2w3" },
    { title: "Review workplace retirement contributions", kind: "deduction", detail: "The 2026 base employee deferral limit is $24,500 across applicable workplace plans; catch-up rules depend on age and plan. Roth contributions do not reduce current taxable wages. Contribution room below excludes catch-ups and is per person.", source: TAX_SOURCES[2].url },
    { title: "Compare itemizing with the standard deduction", kind: "deduction", detail: "Enter only your eligible Schedule A total after limits. For 2026, SALT is capped at $40,400 ($20,200 separately), with MAGI phase-down. Medical expenses generally need to exceed 7.5% of AGI. Mortgage eligibility and debt limits also apply.", source: TAX_SOURCES[1].url },
    { title: "Keep donation receipts", kind: "deduction", detail: "Qualified cash gifts may reduce taxable income by up to $1,000 ($2,000 jointly) when taking the standard deduction. Itemizers must apply the new 0.5% AGI floor and other limits before entering their total. Gifts to individuals do not qualify.", source: TAX_SOURCES[5].url },
    { title: "Separate work expenses from personal spending", kind: "eligibility", detail: "Ordinary W-2 employees generally cannot deduct unreimbursed work or home-office expenses federally. Limited employee exceptions exist. A real self-employed business has different rules and recordkeeping requirements.", source: TAX_SOURCES[4].url },
  ];
  if (p.hasHsa) opportunities.push({ title: "Verify HSA eligibility and employer deposits", kind: "deduction", detail: "2026 base limits are $4,400 self-only or $8,750 family, including employer contributions. Eligibility months, Medicare, other coverage, and catch-ups matter. Only eligible direct contributions not already excluded through payroll belong in confirmed adjustments.", source: TAX_SOURCES[3].url });
  if (p.hasDependents) opportunities.push({ title: "Review dependent and care credits", kind: "credit", detail: "Credits reduce tax rather than taxable income. Child and dependent-care credits require eligibility, income phaseouts, residency, age, and identification checks. No credit is included in this estimate.", source: "https://www.irs.gov/credits-deductions/individuals/child-tax-credit" });
  if (p.hasEducationExpenses) opportunities.push({ title: "Gather Form 1098-T and student-loan records", kind: "credit / deduction", detail: "Education credits and student-loan-interest deductions have separate qualification and income rules. The same expense cannot support multiple tax benefits. These benefits are not included automatically.", source: "https://www.irs.gov/credits-deductions/individuals/education-credits-aotc-and-llc" });
  return {
    year: 2026, verifiedAsOf: TAX_VERIFIED_AS_OF, agi, standardDeduction: standard,
    deductionMethod: useItemized ? "itemized" : "standard", deduction, taxableIncome,
    ordinaryIncomeTaxBeforeCredits: unsupportedReasons.length ? null : ordinary.tax,
    marginalRate: unsupportedReasons.length ? null : ordinary.marginalRate,
    enteredWithholding: p.withholdingBox2,
    baseRetirementRoom: Math.max(0, 24_500 - p.retirementContributions),
    unsupportedReasons, opportunities, sources: TAX_SOURCES,
    limitations: "Planning illustration for 2026 U.S. federal ordinary income only. Not a tax return, refund estimate, or determination of deduction eligibility. Excludes state/local tax liability, payroll and self-employment taxes, capital gains, qualified dividends, AMT, NIIT, credits, and special deductions (including tips/overtime/seniors). Confirm deductions and filing decisions with a qualified tax professional.",
  };
}
