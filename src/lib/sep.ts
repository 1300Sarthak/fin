/**
 * SEP IRA and Solo 401(k) room for a sole proprietor, plus the SE tax that
 * feeds both. Pure; all money in integer cents, rounded at each step the way
 * the IRS worksheets round.
 *
 * 2026 figures added here (VERIFIED 2026-11-11 against the primary sources):
 * - SS wage base $184,500 — SSA, https://www.ssa.gov/oact/cola/cbb.html
 * - §415(c)(1)(A) $72,000, §402(g)(1) $24,500, §401(a)(17)/408(k)(3)(C)
 *   compensation cap $360,000 — IRS Notice 2025-67,
 *   https://www.irs.gov/pub/irs-drop/n-25-67.pdf (402(g) also in
 *   tax-planning.ts TAX_SOURCES[2]).
 * - Method: Pub 560 "Deduction Worksheet for Self-Employed" (25% plan rate
 *   becomes 20% of net profit minus half SE tax), https://www.irs.gov/publications/p560
 * - SE tax: Schedule SE, https://www.irs.gov/forms-pubs/about-schedule-se-form-1040
 */
import { requireLimit } from "./contribution-limits";

export const SEP_2026 = {
  ssWageBaseCents: 18_450_000,
  limit415cCents: requireLimit("k415c", 2026),
  limit402gCents: requireLimit("k402g", 2026),
  compCapCents: 36_000_000,
  seEarningsFactor: 0.9235,
  ssRate: 0.124,
  medicareRate: 0.029,
  /** Net SE earnings below $400 owe no SE tax (Schedule SE line 4c). */
  seFloorCents: 40_000,
  selfEmployedRate: 0.2,
  planRate: 0.25,
  sources: [
    { title: "2026 Social Security wage base", url: "https://www.ssa.gov/oact/cola/cbb.html" },
    { title: "2026 retirement plan limits (Notice 2025-67)", url: "https://www.irs.gov/pub/irs-drop/n-25-67.pdf" },
    { title: "Pub 560: SEP and self-employed deduction worksheet", url: "https://www.irs.gov/publications/p560" },
    { title: "Schedule SE", url: "https://www.irs.gov/forms-pubs/about-schedule-se-form-1040" },
  ],
} as const;

export type SepInput = {
  seGrossCents: number;
  deductibleExpensesCents: number;
  /** W-2 Social Security wages (Box 3); they use up the shared SS wage base. */
  w2SsWagesCents?: number;
  /** Elective deferrals already made to the W-2 401(k) this year; null = unknown. */
  w2DeferralsCents?: number | null;
  /** Where each W-2 figure came from, e.g. "from your paychecks"; shown beside it. */
  w2Sources?: { ssWages?: string; deferrals?: string };
  year?: number;
};

const r = Math.round;

export function computeSep(input: SepInput) {
  const c = SEP_2026;
  const year = input.year ?? 2026;
  const netProfitCents = input.seGrossCents - input.deductibleExpensesCents;
  const netSeEarningsCents = Math.max(0, r(netProfitCents * c.seEarningsFactor));
  const owesSeTax = netSeEarningsCents >= c.seFloorCents;
  const ssRoomCents = Math.max(0, c.ssWageBaseCents - (input.w2SsWagesCents ?? 0));
  const ssTaxableCents = owesSeTax ? Math.min(netSeEarningsCents, ssRoomCents) : 0;
  const ssTaxCents = r(ssTaxableCents * c.ssRate);
  const medicareTaxCents = owesSeTax ? r(netSeEarningsCents * c.medicareRate) : 0;
  const seTaxCents = ssTaxCents + medicareTaxCents;
  const halfSeTaxCents = r(seTaxCents / 2);
  // Pub 560 "compensation" for a sole proprietor, before the plan contribution.
  const compensationCents = Math.max(0, netProfitCents - halfSeTaxCents);
  const byRateCents = r(compensationCents * c.selfEmployedRate);
  const byCompCapCents = r(c.compCapCents * c.planRate);
  const sepMaxCents = Math.min(byRateCents, byCompCapCents, c.limit415cCents);

  // Solo 401(k): the employee piece shares one 402(g) limit with any W-2 plan.
  const w2Known = input.w2DeferralsCents != null;
  const deferralRoomCents = Math.max(0, c.limit402gCents - (input.w2DeferralsCents ?? 0));
  const employerCents = sepMaxCents;
  const employeeCents = Math.max(0, Math.min(deferralRoomCents, compensationCents - employerCents));
  const solo401kTotalCents = Math.min(employeeCents + employerCents, c.limit415cCents, compensationCents);

  return {
    year,
    seGrossCents: input.seGrossCents,
    deductibleExpensesCents: input.deductibleExpensesCents,
    netProfitCents,
    netSeEarningsCents,
    owesSeTax,
    ssRoomCents,
    ssTaxableCents,
    ssTaxCents,
    medicareTaxCents,
    seTaxCents,
    halfSeTaxCents,
    compensationCents,
    sep: { byRateCents, byCompCapCents, limit415cCents: c.limit415cCents, maxCents: sepMaxCents },
    solo401k: { w2DeferralsCents: input.w2DeferralsCents ?? null, w2Known, deferralRoomCents, employeeCents, employerCents, totalCents: solo401kTotalCents },
    w2Sources: { ssWages: input.w2Sources?.ssWages ?? null, deferrals: w2Known ? input.w2Sources?.deferrals ?? null : null },
    deadline: sepDeadline(year),
    notes: [
      "SEP and the Solo 401(k) employer piece are both 20% of (net profit − ½ SE tax): a 25% plan rate on a sole proprietor's own pay.",
      w2Known
        ? `Employee deferral room is the 402(g) limit minus what you defer at your W-2 job this year${input.w2Sources?.deferrals ? ` (${input.w2Sources.deferrals})` : ""}; the limit is per person across every plan.`
        : "W-2 401(k) deferrals unknown: employee room assumes $0 deferred at your W-2 job. Every dollar deferred there reduces this one-for-one.",
      input.w2Sources?.ssWages
        ? `SE tax excludes the 0.9% Additional Medicare Tax; W-2 Social Security wages are ${input.w2Sources.ssWages}.`
        : "SE tax excludes the 0.9% Additional Medicare Tax and any W-2 Box 3 wages not entered.",
    ],
  };
}

/** SEP contributions are due by the return's due date, including extensions. */
export function sepDeadline(year: number) {
  return { withoutExtension: `${year + 1}-04-15`, withExtension: `${year + 1}-10-15`, note: "Due date of the return including extensions; if 4/15 or 10/15 falls on a weekend or holiday, the next business day." };
}

export type SepResult = ReturnType<typeof computeSep>;
