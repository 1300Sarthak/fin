import { z } from "zod";
import { taxProfileSchema, type TaxProfile } from "./financial-planning-core";
import { calculateTaxPlan, ordinaryFederalTax, TAX_SOURCES } from "./tax-planning";
import { computeSep, SEP_2026 } from "./sep";
import { requireLimit, studentLoanInterestDeduction, STUDENT_LOAN_PHASEOUT } from "./contribution-limits";
import { isStudentLoanInterestGoal } from "./goals-core";

/**
 * What a year of pay leaves after tax: federal income tax, FICA on wages, SE
 * tax on 1099 work, California income tax and SDI. Pure; integer cents in and
 * out. A planning illustration, not a return.
 *
 * Constants (VERIFIED 2026-11-12 against the primary sources):
 * - Federal brackets and standard deduction: tax-planning.ts (Rev. Proc. 2025-32).
 * - SS wage base $184,500; SE tax method: sep.ts (SSA, Schedule SE).
 * - Employee FICA 6.2% / 1.45%, Additional Medicare 0.9% over $200k single,
 *   $250k joint, $125k separate: IRS Topic 751 / Form 8959.
 * - QBI deduction: 20% of qualified business income, capped at 20% of taxable
 *   income before it (below the threshold): IRS, §199A.
 * - California 2026 rate schedules, standard deduction $5,900 / $11,800 and
 *   personal exemption credit $158 / $316: FTB Tax News, October 2026 (2026 indexing).
 *   CA allows the ½ SE tax deduction, does not allow QBI, and adds 1% (Mental
 *   Health Services Tax) over $1M.
 * - California SDI 1.3% of all wages (no wage cap since 2024): EDD, 2026 rates.
 */
export const TAKE_HOME_SOURCES = [
  TAX_SOURCES[0],
  { title: "2026 Social Security wage base", url: "https://www.ssa.gov/oact/cola/cbb.html" },
  { title: "Social Security and Medicare withholding (Topic 751)", url: "https://www.irs.gov/taxtopics/tc751" },
  { title: "Additional Medicare Tax (Form 8959)", url: "https://www.irs.gov/forms-pubs/about-form-8959" },
  { title: "Schedule SE", url: "https://www.irs.gov/forms-pubs/about-schedule-se-form-1040" },
  { title: "Qualified business income deduction", url: "https://www.irs.gov/newsroom/qualified-business-income-deduction" },
  { title: "FTB 2026 indexing: CA rate schedules, standard deduction, exemption credits", url: "https://www.ftb.ca.gov/about-ftb/newsroom/tax-news/2026/10.html" },
  { title: "EDD 2026 SDI withholding rate (1.3%)", url: "https://edd.ca.gov/en/payroll_taxes/rates_and_withholding" },
] as const;
export const TAKE_HOME_VERIFIED_AS_OF = "2026-11-12";

type Status = TaxProfile["filingStatus"];
const FICA = { ss: 0.062, medicare: 0.0145, addlMedicare: 0.009 };
const ADDL_MEDICARE_THRESHOLD: Record<Status, number> = { single: 20_000_000, head: 20_000_000, joint: 25_000_000, separate: 12_500_000 };
const QBI_RATE = 0.2;

/** CA 2026 schedules X (single/separate), Y (joint), Z (head): [upper bound in dollars, rate]. */
const CA_RATES = [0.01, 0.02, 0.04, 0.06, 0.08, 0.093, 0.103, 0.113, 0.123];
const CA_BRACKETS: Record<Status, number[]> = {
  single: [11_456, 27_157, 42_861, 59_498, 75_197, 384_109, 460_927, 768_213],
  separate: [11_456, 27_157, 42_861, 59_498, 75_197, 384_109, 460_927, 768_213],
  joint: [22_912, 54_314, 85_722, 118_996, 150_394, 768_218, 921_854, 1_536_426],
  head: [22_927, 54_316, 70_018, 86_654, 102_356, 522_385, 626_864, 1_044_771],
};
const CA_STANDARD: Record<Status, number> = { single: 5_900, separate: 5_900, joint: 11_800, head: 11_800 };
const CA_EXEMPTION_CREDIT: Record<Status, number> = { single: 158, separate: 158, head: 158, joint: 316 };
const CA_MHST = { over: 1_000_000, rate: 0.01 };
const CA_SDI = 0.013;

const r = Math.round;

/** Pure: California tax on taxable income in cents, before credits. */
export function californiaTax(taxableCents: number, status: Status): { taxCents: number; marginalRate: number } {
  const taxable = Math.max(0, taxableCents) / 100;
  let tax = 0, lower = 0, marginalRate = CA_RATES[0];
  for (const [i, upper] of [...CA_BRACKETS[status], Infinity].entries()) {
    const slice = Math.max(0, Math.min(taxable, upper) - lower);
    tax += slice * CA_RATES[i];
    if (slice > 0) marginalRate = CA_RATES[i];
    lower = upper;
  }
  if (taxable > CA_MHST.over) { tax += (taxable - CA_MHST.over) * CA_MHST.rate; marginalRate += CA_MHST.rate; }
  return { taxCents: r(tax * 100), marginalRate };
}

export type TakeHomeInput = {
  filingStatus: Status;
  /** All W-2 pay before any deduction (FICA and SDI wages). */
  w2GrossCents: number;
  /** Pre-tax 401(k)/403(b) deferrals: out of federal and CA wages, not out of FICA/SDI. */
  pretaxDeferralsCents: number;
  /** Payroll (section 125) HSA contributions: out of federal wages, FICA and SDI, but California taxes them. */
  hsaPayrollCents?: number;
  /** Taxable 1099 income and the deductible business expenses against it. */
  seGrossCents: number;
  seExpensesCents: number;
  /** Excluded from every tax; counted in what you keep. */
  nontaxableCents: number;
  /** Federal income tax withheld (W-2 Box 2); null = unknown. */
  federalWithheldCents: number | null;
  /** California income tax withheld (W-2 Box 17); null = unknown. */
  caWithheldCents?: number | null;
  /** Student loan interest paid this year (Form 1098-E); an above-the-line deduction, capped and phased out by MAGI. */
  studentLoanInterestCents?: number;
  /** The tax year the deduction's cap and phase-out are read for; defaults to 2026. */
  year?: number;
};

/** Pure: one year's tax and take-home for the inputs. */
export function computeTakeHome(input: TakeHomeInput) {
  const s = input.filingStatus;
  const hsa = input.hsaPayrollCents ?? 0;
  const box1Cents = Math.max(0, input.w2GrossCents - input.pretaxDeferralsCents - hsa);
  const ficaWagesCents = Math.max(0, input.w2GrossCents - hsa);
  const caWagesCents = Math.max(0, input.w2GrossCents - input.pretaxDeferralsCents);
  const se = computeSep({ seGrossCents: input.seGrossCents, deductibleExpensesCents: input.seExpensesCents, w2SsWagesCents: ficaWagesCents });
  // MAGI for IRC 221 is AGI before the student loan interest deduction.
  const magiCents = box1Cents + se.netProfitCents - se.halfSeTaxCents;
  const studentLoan = studentLoanInterestDeduction(input.studentLoanInterestCents ?? 0, magiCents, s, input.year ?? 2026);
  const agiCents = magiCents - studentLoan.deductionCents;
  const standardCents = calculateTaxPlan(taxProfileSchema.parse({ filingStatus: s })).standardDeduction * 100;
  const beforeQbiCents = Math.max(0, agiCents - standardCents);
  const qbiCents = r(QBI_RATE * Math.min(Math.max(0, se.netProfitCents - se.halfSeTaxCents), beforeQbiCents));
  const federalTaxableCents = Math.max(0, beforeQbiCents - qbiCents);
  const fed = ordinaryFederalTax(federalTaxableCents / 100, s);
  const federalIncomeTaxCents = r(fed.tax * 100);

  const ssCents = r(Math.min(ficaWagesCents, SEP_2026.ssWageBaseCents) * FICA.ss);
  const medicareCents = r(ficaWagesCents * FICA.medicare);
  const addlMedicareCents = r(Math.max(0, ficaWagesCents + se.netSeEarningsCents - ADDL_MEDICARE_THRESHOLD[s]) * FICA.addlMedicare);
  const ficaCents = ssCents + medicareCents + addlMedicareCents;

  // California conforms to the federal student loan interest deduction (Schedule CA makes no adjustment for it).
  const caAgiCents = caWagesCents + se.netProfitCents - se.halfSeTaxCents - studentLoan.deductionCents;
  const caTaxableCents = Math.max(0, caAgiCents - CA_STANDARD[s] * 100);
  const ca = californiaTax(caTaxableCents, s);
  const caIncomeTaxCents = Math.max(0, ca.taxCents - CA_EXEMPTION_CREDIT[s] * 100);
  const sdiCents = r(ficaWagesCents * CA_SDI);

  const totalTaxCents = federalIncomeTaxCents + ficaCents + se.seTaxCents + caIncomeTaxCents + sdiCents;
  const incomeCents = input.w2GrossCents + input.seGrossCents + input.nontaxableCents;
  const keepCents = incomeCents - totalTaxCents;
  const federalOwedCents = input.federalWithheldCents == null ? null : federalIncomeTaxCents + se.seTaxCents - input.federalWithheldCents;
  const caOwedCents = input.caWithheldCents == null ? null : caIncomeTaxCents - input.caWithheldCents;
  return {
    incomeCents, w2GrossCents: input.w2GrossCents, pretaxDeferralsCents: input.pretaxDeferralsCents, hsaPayrollCents: hsa, box1Cents,
    seGrossCents: input.seGrossCents, seExpensesCents: input.seExpensesCents, seNetProfitCents: se.netProfitCents, nontaxableCents: input.nontaxableCents,
    studentLoanInterest: { paidCents: input.studentLoanInterestCents ?? 0, magiCents, deductionCents: studentLoan.deductionCents, capCents: studentLoan.capCents, reducedBy: studentLoan.reducedBy },
    federal: { agiCents, standardDeductionCents: standardCents, qbiDeductionCents: qbiCents, taxableCents: federalTaxableCents, incomeTaxCents: federalIncomeTaxCents, marginalRate: fed.marginalRate },
    fica: { ssCents, medicareCents, addlMedicareCents, totalCents: ficaCents },
    seTax: { netEarningsCents: se.netSeEarningsCents, totalCents: se.seTaxCents, halfDeductionCents: se.halfSeTaxCents },
    california: { agiCents: caAgiCents, taxableCents: caTaxableCents, standardDeductionCents: CA_STANDARD[s] * 100, exemptionCreditCents: CA_EXEMPTION_CREDIT[s] * 100, incomeTaxCents: caIncomeTaxCents, marginalRate: ca.marginalRate, sdiCents },
    totalTaxCents, keepCents,
    effectiveRate: incomeCents > 0 ? totalTaxCents / incomeCents : 0,
    /** Next dollar of W-2 pay: federal + CA brackets + FICA + SDI (SS share drops past the wage base). */
    marginalWageRate: fed.marginalRate + ca.marginalRate + (ficaWagesCents < SEP_2026.ssWageBaseCents ? FICA.ss : 0) + FICA.medicare + CA_SDI,
    federalWithheldCents: input.federalWithheldCents, federalOwedCents,
    caWithheldCents: input.caWithheldCents ?? null, caOwedCents,
  };
}
export type TakeHome = ReturnType<typeof computeTakeHome>;

/** Pure: the extra tax the 1099 income causes — what to set aside, since nothing is withheld from it. */
export function seSetAside(input: TakeHomeInput) {
  const withSe = computeTakeHome(input);
  const without = computeTakeHome({ ...input, seGrossCents: 0, seExpensesCents: 0 });
  const setAsideCents = Math.max(0, withSe.totalTaxCents - without.totalTaxCents);
  const net = input.seGrossCents - input.seExpensesCents;
  return { setAsideCents, rate: net > 0 ? setAsideCents / net : null };
}


/* ---------------------------- payroll withholding ---------------------------- */

/**
 * Per-paycheck withholding, to turn net pay back into gross (the ledger only
 * sees net). VERIFIED 2026-11-12:
 * - Federal: IRS Pub 15-T (2026), Worksheet 1A + STANDARD Withholding Rate
 *   Schedules (W-4 2020+, Step 2 unchecked): annualize, subtract $8,600
 *   ($12,900 joint), apply the schedule, de-annualize.
 * - California: EDD DE 44 (2026) Method B, annual tables: low-income exemption
 *   $18,896 ($37,791 joint/HoH), standard deduction $5,706 ($11,412), Table 5
 *   single rates 1.1%–14.63%, exemption allowance $168.30 each.
 * - FICA 6.2% + 1.45%; CA SDI 1.3% (DE 44, 2026).
 */
