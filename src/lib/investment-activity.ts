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
  if (/\b(cash )?contribution\b|\brollover contribution\b/.test(text)) {
    return { kind: "contribution", label: "Contribution" };
  }
  if (/\b(withdrawal|distribution|disbursement)\b/.test(text)) {
    return { kind: "withdrawal", label: "Withdrawal" };
  }
  if (/\b(dividend|interest|capital gain|cash dividend)\b/.test(text)) {
    return { kind: "investment_income", label: "Investment income" };
  }
  if (/\b(fee|commission|advisory charge)\b/.test(text) || input.categoryName === "Fees & Charges") {
    return { kind: "fee", label: "Fee" };
  }
  if (/\b(buy|sell|trade|reinvestment|exchange)\b/.test(text)) {
    return { kind: "trade", label: "Trade" };
  }
  return { kind: "activity", label: input.categoryKind === "investment" ? "Investment activity" : "Account activity" };
}

/** Contributions are reported as a positive saved amount even when a provider
 * represents the deposit as a negative cash-leg transaction. */
export function contributionAmountCents(amountCents: number): number {
  return Math.abs(amountCents);
}
