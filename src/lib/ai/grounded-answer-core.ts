/**
 * Deterministic copy for questions where a rounded or inferred number would be
 * misleading. Keep the numbers as formatted by the data layer: this module
 * never parses, rounds, or performs currency arithmetic.
 */
export type FinancialHealthSnapshot = {
  netWorth: string;
  assets: string;
  debt: string;
  investments: string;
  averageMonthlyIncome: string;
  averageMonthlySpending: string;
  averageMonthlySaved: string;
  savingsRate: string;
  recentMonths: Array<{ month: string; income: string; spending: string; saved: string }>;
};

export type CashflowSnapshot = {
  month: string;
  income: string;
  spending: string;
  net: string;
};

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Returns the requested calendar month, or the supplied current month. */
export function requestedMonth(question: string, now = new Date()): string {
  const match = MONTHS.findIndex((name) => new RegExp(`\\b${name}(?:\\s+(\\d{4}))?\\b`, "i").test(question));
  if (match < 0) return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const name = MONTHS[match];
  const yearMatch = question.match(new RegExp(`\\b${name}\\s+(\\d{4})\\b`, "i"));
  // A named future month without a year refers to the most recent occurrence.
  const year = yearMatch ? Number(yearMatch[1]) : now.getFullYear() - (match > now.getMonth() ? 1 : 0);
  return `${year}-${String(match + 1).padStart(2, "0")}`;
}

export function isFinancialHealthQuestion(question: string): boolean {
  return /\b(financial health|how (?:am|are) i doing|doing with my finances|my finances|as a \d+[- ]year[- ]old|saving(?:s)? rate|net worth)\b/i.test(question);
}

export function isCashflowSummaryQuestion(question: string): boolean {
  // Merchant-specific questions need the transaction tool rather than a
  // month-wide total ("What did I spend at Amazon?").
  if (/\b(?:at|from)\s+[\p{L}\d][\p{L}\d '&.-]{1,80}\??$/iu.test(question.trim())) return false;
  return /\b(cash ?flow|income|earnings|how much (?:did|do|have) i (?:spend|spent|make|made|earn)|(?:total |monthly )?spending|how much (?:was|is) (?:my )?spending|what did i spend)\b/i.test(question);
}

export function renderCashflowAnswer(snapshot: CashflowSnapshot): string {
  return [
    `**${snapshot.month} cash flow (exact ledger total)**`,
    `- Income: ${snapshot.income}`,
    `- Spending: ${snapshot.spending}`,
    `- Net: ${snapshot.net}`,
    "Transfers, excluded transactions, investment-account activity, and linked refunds are handled by the same accounting rules as the dashboard.",
  ].join("\n");
}

export function renderFinancialHealthAnswer(snapshot: FinancialHealthSnapshot): string {
  const months = snapshot.recentMonths
    .map((month) => `- ${month.month}: made ${month.income}, spent ${month.spending}, net ${month.saved}`)
    .join("\n");
  return [
    "**Your financial snapshot (exact dashboard figures)**",
    `- Net worth: ${snapshot.netWorth} (${snapshot.assets} assets; ${snapshot.debt} debt)`,
    `- Investments: ${snapshot.investments}`,
    `- Average across ${snapshot.recentMonths.length} recorded months: made ${snapshot.averageMonthlyIncome}, spent ${snapshot.averageMonthlySpending}, saved ${snapshot.averageMonthlySaved} (${snapshot.savingsRate} savings rate). This is not any individual month's total.`,
    "",
    "**Recent monthly cash flow**",
    months || "- No recorded cash-flow months yet.",
    "",
    "A useful next step is to compare the highest-spend month above with its category and card breakdown, then set a budget for the largest discretionary category. Age alone is not a benchmark; this is educational guidance, not financial, tax, or investment advice.",
  ].join("\n");
}
