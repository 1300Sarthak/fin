import { describe, expect, test } from "bun:test";
import { classifyInvestmentActivity, contributionAmountCents } from "./investment-activity";

describe("investment activity classification", () => {
  test("treats negative brokerage cash contributions as contributions, not spending", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Cash Contribution Current Year", categoryName: "Taxes" })).toEqual({ kind: "contribution", label: "Contribution" });
    expect(contributionAmountCents(-250000)).toBe(250000);
  });

  test("keeps 401(k) contributions separate from investment income", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Contribution", categoryName: "Investments", categoryKind: "investment" }).kind).toBe("contribution");
    expect(classifyInvestmentActivity({ merchantRaw: "Dividend", categoryName: "Investments", categoryKind: "investment" }).kind).toBe("investment_income");
  });
});
