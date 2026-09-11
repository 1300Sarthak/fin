import { describe, expect, test } from "bun:test";
import { inferAccountType } from "./accounts";

describe("account type inference", () => {
  // "Health Savings Account" contains "Savings", so the generic savings rule
  // used to claim it and the balance counted as spendable cash.
  test("an HSA is not a savings account", () => {
    expect(inferAccountType("Health Savings Account (4598)", "Fidelity Investments")).toBe("hsa");
    expect(inferAccountType("HSA", "Fidelity")).toBe("hsa");
    expect(inferAccountType("Advantage Savings", "Bank of America")).toBe("savings");
  });

  test("retirement wins over the holdings signal", () => {
    expect(inferAccountType("ROTH IRA", "Fidelity Investments", true)).toBe("ira");
    expect(inferAccountType("401(K) PLAN", "Fidelity Investments", true)).toBe("ira");
    expect(inferAccountType("Individual", "Robinhood", true)).toBe("brokerage");
  });

  test("cash management reads as checking, not brokerage", () => {
    expect(inferAccountType("Cash Management (Individual)", "Fidelity Investments", true)).toBe("checking");
  });

  test("cards, crypto, loans, and the fallback", () => {
    expect(inferAccountType("Freedom Unlimited", "Chase Bank")).toBe("credit");
    expect(inferAccountType("Crypto", "Robinhood")).toBe("crypto");
    expect(inferAccountType("Auto Loan", "Bank")).toBe("loan");
    expect(inferAccountType("Something Else", "Somewhere")).toBe("other");
  });
});
