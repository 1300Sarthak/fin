/**
 * How a goal's progress is measured, as pure functions over ledger events.
 * No DB, no clock: `goals.ts` loads the rows and passes today in.
 *
 * "balance" goals read account balances (planner.ts). The others count money
 * put in for one tax year:
 * - roth_ira / hsa: contributions dated in the year, plus prior-year
 *   contributions made by the next April 15 deadline; each double-booked
 *   Fidelity leg and cash sweep is already dropped (event.internal).
 * - k401: employee deposits into a 401(k)/403(b)/457 dated in the year.
 * - manual: a figure the user enters (e.g. interest from Form 1098-E).
 */
import { limitFor, type ContributionLimit, type LimitKind } from "./contribution-limits";

export const PROGRESS_KINDS = ["balance", "roth_ira", "hsa", "k401", "manual"] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];
export const PROGRESS_KIND_LABEL: Record<ProgressKind, string> = {
  balance: "Account balance",
  roth_ira: "Roth IRA contributions",
  hsa: "HSA contributions",
  k401: "401(k) deferrals",
  manual: "Entered manually",
};

/** A contribution as `getInvestmentHistory` reports it, trimmed to what progress needs. */
export type ContributionEvent = {
  txnId: number; date: string; accountId: number; account: string; accountType: string;
  amountCents: number; description: string; internal: boolean;
};
export type CountedRow = { txnId: number; date: string; accountId: number; account: string; cents: number; forYear: number };

const PAYROLL_PLAN = /\b401\s?\(?k\)?|\b403\s?\(?b\)?|\b457\b/i;
const PRIOR_YEAR = /prior year/i;
const isRetirementPlan = (e: ContributionEvent) => PAYROLL_PLAN.test(e.account);

/** The last day a contribution for `year` can be made. IRA/HSA: the filing deadline (no extensions); payroll and interest: Dec 31. */
export function contributionDeadline(kind: ProgressKind, year: number): string | null {
  if (kind === "roth_ira" || kind === "hsa") return `${year + 1}-04-15`;
  if (kind === "k401" || kind === "manual") return `${year}-12-31`;
  return null;
}

/**
 * Pure: which IRA/HSA contribution rows count toward `year`. A row dated in
 * the year counts unless it says "prior year" (that one belongs to year - 1);
 * a "prior year" row dated Jan 1 - Apr 15 of year + 1 counts for `year`.
 */
export function countAnnualContributions(events: ContributionEvent[], kind: "roth_ira" | "hsa", year: number): { cents: number; rows: CountedRow[]; otherYearCents: number } {
  const deadline = contributionDeadline(kind, year)!;
  const mine = events.filter((e) => !e.internal && e.amountCents > 0 && (kind === "hsa" ? e.accountType === "hsa" : e.accountType === "ira" && !isRetirementPlan(e)));
  const rows: CountedRow[] = [];
  let otherYearCents = 0;
  for (const e of mine) {
    const prior = PRIOR_YEAR.test(e.description);
    const y = Number(e.date.slice(0, 4));
    const forYear = prior ? y - 1 : y;
    if (forYear === year && (!prior || e.date <= deadline)) rows.push({ txnId: e.txnId, date: e.date, accountId: e.accountId, account: e.account, cents: e.amountCents, forYear });
    else if (y === year) otherYearCents += e.amountCents;
  }
  return { cents: rows.reduce((s, r) => s + r.cents, 0), rows, otherYearCents };
}

/** Pure: employee 401(k)/403(b)/457 deposits dated in `year`. */
export function count401k(events: ContributionEvent[], year: number): { cents: number; rows: CountedRow[] } {
  const rows = events
    .filter((e) => !e.internal && e.amountCents > 0 && isRetirementPlan(e) && e.date.startsWith(`${year}-`))
    .map((e) => ({ txnId: e.txnId, date: e.date, accountId: e.accountId, account: e.account, cents: e.amountCents, forYear: year }));
  return { cents: rows.reduce((s, r) => s + r.cents, 0), rows };
}

/** The table row behind a goal's target, if any: IRA, 402(g), HSA (family when the target is above self-only), or student loan interest. */
export function limitForGoal(kind: ProgressKind, year: number | null, targetCents: number, isStudentLoanInterest: boolean): ContributionLimit | null {
  if (year == null) return null;
  let k: LimitKind | null = null;
  if (kind === "roth_ira") k = "ira";
  else if (kind === "k401") k = "k402g";
  else if (kind === "hsa") k = targetCents > (limitFor("hsa_self", year)?.cents ?? Infinity) ? "hsa_family" : "hsa_self";
  else if (kind === "manual" && isStudentLoanInterest) k = "student_loan_interest";
  return k ? limitFor(k, year) : null;
}

/** The goal the take-home estimate reads interest from: entered manually, for a tax year, named for student loan interest. */
export function isStudentLoanInterestGoal(g: { name: string; progressKind: string; taxYear: number | null }): boolean {
  return g.progressKind === "manual" && g.taxYear != null && /student\s*loan\s*interest/i.test(g.name);
}

/** Loan servicers, and a large Education-category payment (often a school's own loan or fee). */
const LOAN_PAYEE = /nelnet|navient|mohela|aidvantage|edfinancial|great lakes|sallie ?mae|student ?loan|dept\.? ?of ?ed|ecsi|heartland/i;
export type LoanPaymentRow = { txnId: number; date: string; accountId: number; account: string; merchant: string; category: string | null; amountCents: number };
/** Pure: outflows in `year` that look like a student loan payment. Shown as evidence only; a payment is mostly principal. */
export function findLoanPayments(rows: LoanPaymentRow[], year: number): LoanPaymentRow[] {
  return rows.filter((r) => r.date.startsWith(`${year}-`) && r.amountCents < 0
    && (LOAN_PAYEE.test(r.merchant) || (r.category === "Education" && r.amountCents <= -100_000)));
}

export type K401Plan = { remainingChecks: number; neededPerCheckCents: number; neededPct: number | null; verdict: "maxed" | "on track" | "raise" | "stretch" | "impossible" | "no paychecks left"; message: string };

/**
 * Pure: what each remaining paycheck must defer to reach the limit. "stretch"
 * above 75% of gross (most plans and net pay after FICA/tax will not allow
 * more), "impossible" above 100%.
 */
export function plan401k(input: { year: number; limitCents: number; ytdCents: number; postingCents: number; remainingChecks: number; perCheckGrossCents: number; projectedCents: number }): K401Plan {
  const left = Math.max(0, input.limitCents - input.ytdCents - input.postingCents);
  const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (left === 0) return { remainingChecks: input.remainingChecks, neededPerCheckCents: 0, neededPct: 0, verdict: "maxed", message: "At the limit once posted deposits land." };
  if (input.remainingChecks <= 0) return { remainingChecks: 0, neededPerCheckCents: left, neededPct: null, verdict: "no paychecks left", message: `No paychecks left this year; ${$(left)} of room goes unused.` };
  const per = Math.ceil(left / input.remainingChecks);
  const pctRaw = input.perCheckGrossCents > 0 ? per / input.perCheckGrossCents : null;
  const pctText = pctRaw == null ? "" : ` (${Math.round(pctRaw * 100)}% of pay)`;
  const checks = `${input.remainingChecks} check${input.remainingChecks === 1 ? "" : "s"}`;
  if (input.projectedCents >= left) return { remainingChecks: input.remainingChecks, neededPerCheckCents: per, neededPct: pctRaw, verdict: "on track", message: `Your current rate reaches the limit; needs ${$(per)} per check${pctText} over ${checks}.` };
  if (pctRaw != null && pctRaw > 1) return { remainingChecks: input.remainingChecks, neededPerCheckCents: per, neededPct: pctRaw, verdict: "impossible", message: `Needs ${$(per)} per check${pctText} over the last ${checks}, more than the whole paycheck. Maxing ${input.year} is not possible; ${$(input.postingCents + input.projectedCents)} more is on pace.` };
  if (pctRaw != null && pctRaw > 0.75) return { remainingChecks: input.remainingChecks, neededPerCheckCents: per, neededPct: pctRaw, verdict: "stretch", message: `Needs ${$(per)} per check${pctText} over ${checks}, above what payroll usually allows after taxes.` };
  return { remainingChecks: input.remainingChecks, neededPerCheckCents: per, neededPct: pctRaw, verdict: "raise", message: `Raise your election to ${$(per)} per check${pctText} for the last ${checks}.` };
}

/** Whole months from `today`'s month to `day`'s month; month 1 = this month (the waterfall's first contribution). */
export function monthIndex(today: string, day: string): number {
  const [ty, tm] = today.split("-").map(Number);
  const [y, m] = day.split("-").map(Number);
  return (y - ty) * 12 + (m - tm) + 1;
}

export type AnnualWindow = "open" | "upcoming" | "closed";
/** Pure: whether money can still go toward a tax-year goal today. Before Jan 1 of the year: upcoming; after its deadline: closed. */
export function annualWindow(kind: ProgressKind, year: number | null, today: string): AnnualWindow | null {
  if (year == null || kind === "balance") return null;
  const deadline = contributionDeadline(kind, year);
  if (today < `${year}-01-01`) return "upcoming";
  if (deadline && today > deadline) return "closed";
  return "open";
}

/**
 * Pure: the contribution plan's view of a goal. Funded, closed and
 * payroll-funded (401k) goals are left out; an upcoming year opens in the
 * month it starts; every annual goal stops taking money at its deadline.
 */
export function planWindow(g: { progressKind: ProgressKind; taxYear: number | null; targetCents: number; currentCents: number }, today: string): { include: false; why: string } | { include: true; opensInMonths?: number; closesAfterMonths?: number } {
  if (g.targetCents > 0 && g.currentCents >= g.targetCents) return { include: false, why: "funded" };
  if (g.progressKind === "k401") return { include: false, why: "funded through payroll, not from surplus" };
  const w = annualWindow(g.progressKind, g.taxYear, today);
  if (w == null) return { include: true };
  if (w === "closed") return { include: false, why: "contribution window closed" };
  const deadline = contributionDeadline(g.progressKind, g.taxYear!)!;
  return { include: true, opensInMonths: w === "upcoming" ? monthIndex(today, `${g.taxYear}-01-01`) : undefined, closesAfterMonths: monthIndex(today, deadline) };
}
