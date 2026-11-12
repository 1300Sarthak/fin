import { isoDate } from "@/lib/format";

export type InvestmentActivityKind =
  | "contribution"
  | "withdrawal"
  | "investment_income"
  | "fee"
  | "trade"
  | "activity";

export type InvestmentActivityClassification = {
  kind: InvestmentActivityKind;
  label: string;
};

/**
 * Brokerage feeds do not consistently use cash-flow signs for retirement
 * accounts: some report a cash contribution as a negative ledger row.
 * Classify the economic event from the institution's description before using
 * its sign for UI labels or contribution totals.
 */
export function classifyInvestmentActivity(input: {
  merchantRaw: string;
  categoryName?: string | null;
  categoryKind?: string | null;
}): InvestmentActivityClassification {
  const text = `${input.merchantRaw} ${input.categoryName ?? ""}`.toLowerCase();
  if (/\b(cash )?contribution\b|\brollover contribution\b|\bpartic contr\b/.test(text)) {
    return { kind: "contribution", label: "Contribution" };
  }
  if (/\b(withdrawal|distribution|disbursement)\b/.test(text)) {
    return { kind: "withdrawal", label: "Withdrawal" };
  }
  if (/\b(dividend|interest|capital gain|cash dividend)\b/.test(text)) {
    return { kind: "investment_income", label: "Investment income" };
  }
  // Fidelity books every money-market sweep leg under its own bare name, and the
  // categorizer files those as "Fees & Charges". They move cash between the
  // core position and a buy/sell/deposit — never a fee, never income.
  if (isSweepText(input.merchantRaw)) return { kind: "trade", label: "Cash sweep" };
  if (/\b(fee|commission|advisory charge)\b/.test(text) || input.categoryName === "Fees & Charges") {
    return { kind: "fee", label: "Fee" };
  }
  if (/\b(buy|sell|trade|reinvestment|exchange)\b/.test(text)) {
    return { kind: "trade", label: "Trade" };
  }
  return { kind: "activity", label: input.categoryKind === "investment" ? "Investment activity" : "Account activity" };
}

/**
 * The one normal form the sweep rule reads: ASCII letters lowercased and ASCII
 * whitespace (tab, LF, VT, FF, CR, space) removed. Both steps are ones SQLite's
 * lower() and replace() reproduce exactly, so `cashSweepSql` in
 * cashflow-scope.ts cannot disagree with this function.
 */
export const sweepKey = (text: string): string =>
  text.replace(/[\t\n\v\f\r ]/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Whole descriptors that are always a sweep leg. */
export const SWEEP_EXACT = ["fidelity", "realizedgainloss", "realizedgain/loss"] as const;

/**
 * A bare "Fidelity" row, Fidelity's realized gain/loss line, or a leg into or
 * out of a Fidelity money-market fund: internal cash movement. Only meaningful
 * on an account that has a money-market core; see `isCashSweep`.
 */
export function isSweepText(merchantRaw: string): boolean {
  const key = sweepKey(merchantRaw);
  return (SWEEP_EXACT as readonly string[]).includes(key) || (key.includes("fidelity") && key.includes("moneymarket"));
}

/** Contributions are reported as a positive saved amount even when a provider
 * represents the deposit as a negative cash-leg transaction. */
export function contributionAmountCents(amountCents: number): number {
  return Math.abs(amountCents);
}

export type ContributionLeg = { id: number; accountId: number; day: string; amountCents: number };

/**
 * Fidelity reports one contribution as two rows on the same day in the same
 * account: a negative "Cash Contribution Current Year" and a positive "Current
 * Year Contribution" of the same size. Pure: map each redundant leg's id to the
 * id of the leg kept. Only equal-size, opposite-sign rows pair, each at most
 * once, and the positive leg is kept; two same-sign rows are two contributions.
 */
export function duplicateContributionLegs(legs: ContributionLeg[]): Map<number, number> {
  const groups = new Map<string, ContributionLeg[]>();
  for (const l of legs) {
    if (!l.amountCents) continue;
    const key = `${l.accountId}|${l.day}|${Math.abs(l.amountCents)}`;
    const g = groups.get(key);
    if (g) g.push(l); else groups.set(key, [l]);
  }
  const dropped = new Map<number, number>();
  for (const g of groups.values()) {
    const pos = g.filter((l) => l.amountCents > 0).sort((a, b) => a.id - b.id);
    const neg = g.filter((l) => l.amountCents < 0).sort((a, b) => a.id - b.id);
    for (let i = 0; i < Math.min(pos.length, neg.length); i++) dropped.set(neg[i].id, pos[i].id);
  }
  return dropped;
}

/**
 * The contribution rows to count: classified as contributions, with the
 * redundant leg of each same-day double report removed. Every consumer that
 * sums contributions should go through this rather than filtering on
 * `classifyInvestmentActivity` alone.
 */
export function countedContributions<T extends { id: number; accountId: number; postedAt: Date; amountCents: number; merchantRaw: string; categoryName?: string | null; categoryKind?: string | null }>(rows: T[]): T[] {
  const contributions = rows.filter((r) => classifyInvestmentActivity(r).kind === "contribution");
  const dropped = duplicateContributionLegs(contributions.map((r) => ({ id: r.id, accountId: r.accountId, day: isoDate(r.postedAt), amountCents: r.amountCents })));
  return contributions.filter((r) => !dropped.has(r.id));
}
