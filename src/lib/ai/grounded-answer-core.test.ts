import { describe, expect, test } from "bun:test";
import {
  isCashflowSummaryQuestion,
  isFinancialHealthQuestion,
  renderCashflowAnswer,
  renderFinancialHealthAnswer,
  requestedMonth,
} from "./grounded-answer-core";

describe("deterministic finance chat answers", () => {
  test("keeps July's exact spending instead of allowing an approximate model claim", () => {
    const answer = renderCashflowAnswer({
      month: "July 2026",
      income: "$4,200.00",
      spending: "$3,100.00",
      net: "$1,100.00",
    });
    expect(answer).toContain("July 2026 cash flow (exact ledger total)");
    expect(answer).toContain("Spending: $3,100.00");
    expect(answer).not.toContain("$3,000");
  });

  test("uses the financial-health renderer for age-based questions and labels every month", () => {
    expect(isFinancialHealthQuestion("As a 30 year old, how am I doing with my finances?")).toBe(true);
    const answer = renderFinancialHealthAnswer({
      netWorth: "$12,000.00", assets: "$14,000.00", debt: "$2,000.00", investments: "$3,000.00",
      averageMonthlyIncome: "$4,200.00", averageMonthlySpending: "$3,100.00", averageMonthlySaved: "$1,100.00", savingsRate: "26%",
      recentMonths: [{ month: "2026-07", income: "$4,200.00", spending: "$3,100.00", saved: "$1,100.00" }],
    });
    expect(answer).toContain("2026-07: made $4,200.00, spent $3,100.00");
  });

  test("selects the requested month and leaves merchant-detail questions for tools", () => {
    expect(requestedMonth("what did I spend in July?", new Date("2026-08-24T12:00:00"))).toBe("2026-07");
    expect(isCashflowSummaryQuestion("What did I spend in July?")).toBe(true);
    expect(isCashflowSummaryQuestion("What did I spend at Amazon?")).toBe(false);
  });
});
