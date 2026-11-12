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
export const WITHHOLDING_SOURCES = [
  { title: "IRS Pub 15-T (2026): percentage method tables", url: "https://www.irs.gov/pub/irs-pdf/p15t.pdf" },
  { title: "EDD DE 44 (2026): California withholding schedules", url: "https://www.edd.ca.gov/siteassets/files/pdf_pub_ctr/de44.pdf" },
] as const;
const FED_WH_ADJUST: Record<Status, number> = { single: 8_600, separate: 8_600, head: 8_600, joint: 12_900 };
const FED_WH_FROM: Record<Status, number[]> = {
  single: [7_500, 19_900, 57_900, 113_200, 209_275, 263_725, 648_100],
  separate: [7_500, 19_900, 57_900, 113_200, 209_275, 263_725, 648_100],
  head: [15_550, 33_250, 83_000, 121_250, 217_300, 271_750, 656_150],
  joint: [19_300, 44_100, 120_100, 230_700, 422_850, 531_750, 788_000],
};
const FED_WH_RATES = [0.10, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];
// DE 44 Table 5 (single); the joint table is exactly double. Head of household is approximated with the joint table.
const CA_WH_FROM_SINGLE = [0, 11_079, 26_264, 41_452, 57_542, 72_724, 371_479, 445_771, 742_953, 1_000_000];
const CA_WH_RATES = [0.011, 0.022, 0.044, 0.066, 0.088, 0.1023, 0.1133, 0.1243, 0.1353, 0.1463];
const CA_WH_LOW_INCOME = { single: 18_896, separate: 18_896, joint: 37_791, head: 37_791 } as const;
const CA_WH_STANDARD = { single: 5_706, separate: 5_706, joint: 11_412, head: 11_412 } as const;
const CA_WH_ALLOWANCE = 168.3;

const progressive = (amount: number, from: number[], rates: number[]) => {
  let tax = 0;
  for (let i = 0; i < from.length; i++) {
    const upper = from[i + 1] ?? Infinity;
    if (amount > from[i]) tax += (Math.min(amount, upper) - from[i]) * rates[i];
  }
  return tax;
};

export type PayrollOpts = { status: Status; periods: number; caAllowances: number; pretax401kCents: number; roth401kCents: number; hsaPayrollCents: number };
export type Withholding = { grossCents: number; federalCents: number; ficaCents: number; caCents: number; sdiCents: number; netCents: number };

/** Pure: one paycheck's withholding and net for a gross amount. */
export function withholdingFor(grossCents: number, o: PayrollOpts): Withholding {
  const fedWages = Math.max(0, grossCents - o.pretax401kCents - o.hsaPayrollCents) / 100;
  const annualFed = Math.max(0, fedWages * o.periods - FED_WH_ADJUST[o.status]);
  const federalCents = r((progressive(annualFed, [0, ...FED_WH_FROM[o.status]], [0, ...FED_WH_RATES]) / o.periods) * 100);
  const ficaWages = Math.max(0, grossCents - o.hsaPayrollCents);
  const ficaCents = r(ficaWages * (FICA.ss + FICA.medicare));
  const caAnnual = (Math.max(0, grossCents - o.pretax401kCents) / 100) * o.periods;
  const double = o.status === "joint" || o.status === "head";
  let caCents = 0;
  if (caAnnual > CA_WH_LOW_INCOME[o.status]) {
    const taxable = Math.max(0, caAnnual - CA_WH_STANDARD[o.status]);
    const tax = progressive(taxable, CA_WH_FROM_SINGLE.map((x) => (double ? x * 2 : x)), CA_WH_RATES) - o.caAllowances * CA_WH_ALLOWANCE;
    caCents = r((Math.max(0, tax) / o.periods) * 100);
  }
  const sdiCents = r(ficaWages * CA_SDI);
  return { grossCents, federalCents, ficaCents, caCents, sdiCents, netCents: grossCents - o.pretax401kCents - o.roth401kCents - o.hsaPayrollCents - federalCents - ficaCents - caCents - sdiCents };
}

/** Pure: the gross that nets to `netCents` (net = everything deposited anywhere). Bisection to the cent; net is monotonic in gross. */
export function solveGross(netCents: number, o: PayrollOpts): Withholding {
  let lo = netCents, hi = Math.max(netCents, 1) * 3 + o.pretax401kCents + o.roth401kCents + o.hsaPayrollCents;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (withholdingFor(mid, o).netCents < netCents) lo = mid; else hi = mid;
  }
  const a = withholdingFor(lo, o), b = withholdingFor(hi, o);
  return Math.abs(a.netCents - netCents) <= Math.abs(b.netCents - netCents) ? a : b;
}

export type PayLeg = {
  txnId: number; date: string; account: string; accountId: number; cents: number; kind: "bank" | "roth-ira" | "hsa" | "401k";
  /** A 401(k) deposit spread over several paydays: this paycheck's slice is `cents` of `totalCents`, one of `paydays`. */
  share?: { totalCents: number; paydays: number };
};
export type Paycheck = { date: string; legs: PayLeg[]; netCents: number; deferral401kCents: number; hsaCents: number };

/**
 * Pure: group a job's money into paychecks. Bank deposits and Roth IRA
 * direct deposits within 4 days are one paycheck; HSA deposits within 3 days
 * join it. A 401(k) deposit covers every payday since the previous 401(k)
 * deposit (the plan often posts several paydays' deferrals at once), split
 * evenly; the first one of the year covers only the nearest payday up to 7 days
 * before it, since nothing says deferrals started earlier. Anything that fits
 * no paycheck is returned as `stray`.
 */
export function buildPaychecks(legs: PayLeg[]): { paychecks: Paycheck[]; stray: PayLeg[] } {
  const anchors = legs.filter((l) => l.kind === "bank" || l.kind === "roth-ira").sort((a, b) => a.date.localeCompare(b.date) || a.txnId - b.txnId);
  const paychecks: Paycheck[] = [];
  for (const l of anchors) {
    const last = paychecks.at(-1);
    if (last && daysBetween(last.date, l.date) <= 4) last.legs.push(l);
    else paychecks.push({ date: l.date, legs: [l], netCents: 0, deferral401kCents: 0, hsaCents: 0 });
  }
  const stray: PayLeg[] = [];
  const nearest = (l: PayLeg, before: number, after: number) => paychecks
    .filter((p) => { const d = daysBetween(p.date, l.date); return d >= -before && d <= after; })
    .sort((a, b) => Math.abs(daysBetween(a.date, l.date)) - Math.abs(daysBetween(b.date, l.date)))[0];
  for (const l of legs.filter((x) => x.kind === "hsa")) { const p = nearest(l, 3, 3); if (p) { p.legs.push(l); p.hsaCents += l.cents; } else stray.push(l); }
  let previous: string | null = null;
  for (const l of legs.filter((x) => x.kind === "401k").sort((a, b) => a.date.localeCompare(b.date) || a.txnId - b.txnId)) {
    const span = previous == null ? [] : paychecks.filter((p) => p.date > previous! && daysBetween(p.date, l.date) >= -1);
    const covered = span.length ? span : [nearest(l, 1, 7)].filter((p): p is Paycheck => !!p);
    previous = l.date;
    if (!covered.length) { stray.push(l); continue; }
    const each = Math.floor(l.cents / covered.length);
    covered.forEach((p, i) => {
      const cents = i === covered.length - 1 ? l.cents - each * (covered.length - 1) : each;
      p.legs.push(covered.length > 1 ? { ...l, cents, share: { totalCents: l.cents, paydays: covered.length } } : l);
      p.deferral401kCents += cents;
    });
  }
  for (const p of paychecks) p.netCents = p.legs.filter((l) => l.kind === "bank" || l.kind === "roth-ira").reduce((n, l) => n + l.cents, 0);
  return { paychecks, stray };
}
const medianOf = (xs: number[]) => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b), m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY_MS);

/* ------------------------------ W-2 gross estimate ------------------------------ */

const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(utc(d) + n * DAY_MS).toISOString().slice(0, 10);

export type PayrollAssumptions = { annualSalaryCents: number; fullTimeStart: string | null; periods: number; caAllowances: number; k401Type: "pretax" | "roth"; k401Pct: number | null; hsaPayroll: boolean; projectRest: boolean };
export type ReconstructedPaycheck = Paycheck & Withholding & {
  fullTime: boolean; incomplete: boolean; expectedGrossCents: number | null; residualCents: number | null;
  /** What the year total uses: the rebuilt gross, or salary ÷ periods for a full-time check whose legs are still posting. */
  counted: Withholding;
};

/**
 * Pure: the year's W-2 pay rebuilt from the ledger. Each paycheck's net
 * (bank + Roth IRA direct deposit; HSA deposits too unless they are payroll
 * pre-tax) is grossed up through the withholding model. Full-time checks are
 * compared against salary ÷ periods, and the year is projected at that rate
 * through Dec 31.
 */
export function reconstructPayroll(paychecks: Paycheck[], a: PayrollAssumptions, status: Status, year: number, today: string) {
  const perCheck = r(a.annualSalaryCents / a.periods);
  const rows: ReconstructedPaycheck[] = paychecks.map((p) => {
    const hsaPre = a.hsaPayroll ? p.hsaCents : 0;
    const net = p.netCents + (a.hsaPayroll ? 0 : p.hsaCents);
    const w = solveGross(net, { status, periods: a.periods, caAllowances: a.caAllowances, pretax401kCents: a.k401Type === "pretax" ? p.deferral401kCents : 0, roth401kCents: a.k401Type === "roth" ? p.deferral401kCents : 0, hsaPayrollCents: hsaPre });
    // The first check after the start date usually covers part intern, part full-time: not a fair comparison.
    const fullTime = !!a.fullTimeStart && daysBetween(a.fullTimeStart, p.date) >= 14;
    // 401(k) and HSA legs post up to a week after payday, so a recent check may still be missing money.
    const incomplete = daysBetween(p.date, today) < 7;
    const compared = fullTime && !incomplete;
    return { ...p, ...w, counted: w, fullTime, incomplete, expectedGrossCents: compared ? perCheck : null, residualCents: compared ? w.grossCents - perCheck : null };
  });
  const sum = (f: (x: ReconstructedPaycheck) => number) => rows.reduce((n, x) => n + f(x), 0);
  const complete = rows.filter((x) => x.fullTime && !x.incomplete && x.grossCents > 0);
  // Deferral rate: the user's election when given, else the median share of gross over complete full-time checks.
  const observed = medianOf(complete.map((x) => x.deferral401kCents / x.grossCents));
  const k401Rate = a.k401Pct != null ? a.k401Pct / 100 : observed ?? 0;
  const deferralPerCheck = r(k401Rate * perCheck);
  const hsaPerCheck = complete.at(-1)?.hsaCents ?? 0;
  const salaryCheck = withholdingFor(perCheck, { status, periods: a.periods, caAllowances: a.caAllowances, pretax401kCents: a.k401Type === "pretax" ? deferralPerCheck : 0, roth401kCents: a.k401Type === "roth" ? deferralPerCheck : 0, hsaPayrollCents: a.hsaPayroll ? hsaPerCheck : 0 });
  // A full-time check still posting is counted at the salary rate, including the deferral that has not posted yet.
  let postingDeferral = 0;
  for (const x of rows) if (x.fullTime && x.incomplete && x.grossCents < perCheck) { x.counted = salaryCheck; postingDeferral += Math.max(0, deferralPerCheck - x.deferral401kCents); }
  const last = rows.at(-1);
  const remaining: string[] = [];
  if (a.projectRest && last && a.fullTimeStart && last.date >= a.fullTimeStart) {
    const step = Math.round(365 / a.periods);
    for (let d = addDays(last.date, step); d <= `${year}-12-31`; d = addDays(d, step)) remaining.push(d);
  }
  const n = remaining.length;
  return {
    paychecks: rows, perCheckCents: perCheck, remainingPaydays: remaining, salaryCheck,
    k401: { rate: k401Rate, source: a.k401Pct != null ? "your election" as const : observed != null ? "median of complete full-time checks" as const : "none observed" as const, perCheckCents: deferralPerCheck, postingCents: postingDeferral },
    ytd: { grossCents: sum((x) => x.counted.grossCents), netCents: sum((x) => x.netCents), deferral401kCents: sum((x) => x.deferral401kCents) + postingDeferral, hsaCents: sum((x) => x.hsaCents), federalCents: sum((x) => x.counted.federalCents), caCents: sum((x) => x.counted.caCents), ficaCents: sum((x) => x.counted.ficaCents), sdiCents: sum((x) => x.counted.sdiCents) },
    projected: { grossCents: n * perCheck, deferral401kCents: n * deferralPerCheck, hsaCents: n * hsaPerCheck, federalCents: n * salaryCheck.federalCents, caCents: n * salaryCheck.caCents },
    /** Mean gross − expected over the full-time checks; null when there are none. */
    meanResidualCents: rows.some((x) => x.residualCents != null) ? r(sum((x) => x.residualCents ?? 0) / rows.filter((x) => x.residualCents != null).length) : null,
  };
}
export type Payroll = ReturnType<typeof reconstructPayroll>;
