/**
 * Yearly contribution and deduction limits, in one table. Pure; integer cents.
 * Every entry says whether the IRS has published it ("official") or it is a
 * placeholder until it does ("projected"). Update a projected row when the
 * notice comes out (the IRS usually publishes next year's limits in Oct-Nov).
 *
 * Checked 2026-11-12:
 * - 2026 IRA $7,500, 402(g) $24,500, 415(c) $72,000: IRS Notice 2025-67.
 * - 2026 HSA $4,400 self-only / $8,750 family: Rev. Proc. 2025-19.
 * - 2027 HSA $4,500 / $9,000: Rev. Proc. 2026-24.
 * - 2026 student loan interest: $2,500 cap (IRC 221(b)(1), not indexed); MAGI
 *   phase-out $85,000-$100,000 single, $175,000-$205,000 joint: Rev. Proc. 2025-32 sec. 3.29.
 * - 2027 IRA, 402(g), 415(c): not announced yet. Forecasts: IRA $7,500-$8,000,
 *   402(g) $25,000-$25,500 (Milliman's final estimate $25,500).
 */
export type LimitKind = "ira" | "k402g" | "k415c" | "hsa_self" | "hsa_family" | "student_loan_interest";
export type LimitStatus = "official" | "projected";
export type LimitSource = { title: string; url: string };
export type ContributionLimit = { kind: LimitKind; year: number; cents: number; status: LimitStatus; source: LimitSource; note?: string };

const NOTICE_2025_67: LimitSource = { title: "IRS Notice 2025-67: 2026 retirement plan limits", url: "https://www.irs.gov/pub/irs-drop/n-25-67.pdf" };
const RP_2025_19: LimitSource = { title: "Rev. Proc. 2025-19: 2026 HSA limits", url: "https://www.irs.gov/irb/2025-21_IRB#REV-PROC-2025-19" };
const RP_2026_24: LimitSource = { title: "Rev. Proc. 2026-24: 2027 HSA limits", url: "https://www.irs.gov/pub/irs-drop/rp-26-24.pdf" };
const RP_2025_32: LimitSource = { title: "Rev. Proc. 2025-32 sec. 3.29: 2026 student loan interest phase-out", url: "https://www.irs.gov/pub/irs-drop/rp-25-32.pdf" };
const PUB_970: LimitSource = { title: "IRS Pub 970, ch. 4: Student loan interest deduction", url: "https://www.irs.gov/publications/p970" };
const PROJECTED_2027: LimitSource = { title: "Not announced yet; IRS newsroom (limits usually published in November)", url: "https://www.irs.gov/newsroom" };
const UPDATE = "projected — update when IRS announces (usually Nov)";

export const CONTRIBUTION_LIMITS: readonly ContributionLimit[] = [
  { kind: "ira", year: 2026, cents: 750_000, status: "official", source: NOTICE_2025_67 },
  { kind: "k402g", year: 2026, cents: 2_450_000, status: "official", source: NOTICE_2025_67 },
  { kind: "k415c", year: 2026, cents: 7_200_000, status: "official", source: NOTICE_2025_67, note: "Employee deferrals plus employer match and after-tax money, per plan." },
  { kind: "hsa_self", year: 2026, cents: 440_000, status: "official", source: RP_2025_19 },
  { kind: "hsa_family", year: 2026, cents: 875_000, status: "official", source: RP_2025_19 },
  { kind: "student_loan_interest", year: 2026, cents: 250_000, status: "official", source: PUB_970 },

  { kind: "ira", year: 2027, cents: 750_000, status: "projected", source: PROJECTED_2027, note: `${UPDATE}; forecasts $7,500-$8,000` },
  { kind: "k402g", year: 2027, cents: 2_450_000, status: "projected", source: PROJECTED_2027, note: `${UPDATE}; 2026 figure as a placeholder, forecasts $25,000-$25,500` },
  { kind: "k415c", year: 2027, cents: 7_200_000, status: "projected", source: PROJECTED_2027, note: `${UPDATE}; 2026 figure as a placeholder` },
  { kind: "hsa_self", year: 2027, cents: 450_000, status: "official", source: RP_2026_24 },
  { kind: "hsa_family", year: 2027, cents: 900_000, status: "official", source: RP_2026_24 },
  { kind: "student_loan_interest", year: 2027, cents: 250_000, status: "official", source: PUB_970, note: "The $2,500 cap is set by statute and is not indexed." },
];

/** The limit for a year, or null when the table has no row for it. */
export function limitFor(kind: LimitKind, year: number): ContributionLimit | null {
  return CONTRIBUTION_LIMITS.find((l) => l.kind === kind && l.year === year) ?? null;
}

/** Same, for a year the table must cover (module constants); throws on a gap. */
export function requireLimit(kind: LimitKind, year: number): number {
  const l = limitFor(kind, year);
  if (!l) throw new Error(`no ${kind} limit on file for ${year}`);
  return l.cents;
}

/** Student loan interest MAGI phase-out, in cents: begins above `from`, gone at `to`. Married filing separately cannot take it. */
export type PhaseOut = { from: number; to: number; status: LimitStatus; source: LimitSource };
export const STUDENT_LOAN_PHASEOUT: Record<number, { single: PhaseOut; joint: PhaseOut }> = {
  2026: {
    single: { from: 8_500_000, to: 10_000_000, status: "official", source: RP_2025_32 },
    joint: { from: 17_500_000, to: 20_500_000, status: "official", source: RP_2025_32 },
  },
};

/**
 * Pure: the deductible part of student loan interest paid (IRC 221). Capped at
 * the year's $2,500, then reduced linearly across the MAGI phase-out. MAGI is
 * AGI before this deduction. Head of household uses the single range.
 */
export function studentLoanInterestDeduction(interestCents: number, magiCents: number, status: "single" | "joint" | "head" | "separate", year: number): { deductionCents: number; capCents: number; phaseOut: PhaseOut | null; reducedBy: number } {
  const capCents = limitFor("student_loan_interest", year)?.cents ?? 250_000;
  const allowed = Math.min(Math.max(0, interestCents), capCents);
  if (status === "separate") return { deductionCents: 0, capCents, phaseOut: null, reducedBy: 1 };
  const range = STUDENT_LOAN_PHASEOUT[year]?.[status === "joint" ? "joint" : "single"] ?? null;
  if (!range) return { deductionCents: allowed, capCents, phaseOut: null, reducedBy: 0 };
  const reducedBy = Math.min(1, Math.max(0, (magiCents - range.from) / (range.to - range.from)));
  return { deductionCents: Math.round(allowed * (1 - reducedBy)), capCents, phaseOut: range, reducedBy };
}
