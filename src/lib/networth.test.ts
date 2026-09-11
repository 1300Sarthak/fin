import { describe, expect, test } from "bun:test";
import { calculateLiquidMoney } from "./liquid-money";

describe("liquid money", () => {
  test("uses an asset's available balance, excludes investments, and subtracts only owed balances", () => {
    const summary = calculateLiquidMoney([
      { type: "checking", isAsset: true, currentBalanceCents: 100_000, availableBalanceCents: 92_500 },
      { type: "savings", isAsset: true, currentBalanceCents: 50_000, availableBalanceCents: null },
      { type: "ira", isAsset: true, currentBalanceCents: 300_000, availableBalanceCents: 300_000 },
      { type: "brokerage", isAsset: true, currentBalanceCents: 200_000, availableBalanceCents: null },
      // A card's available credit must not add to liquid assets.
      { type: "credit", isAsset: false, currentBalanceCents: 20_000, availableBalanceCents: 480_000 },
    ]);

    expect(summary).toEqual({
      liquidAssetsCents: 142_500,
      liabilitiesCents: 20_000,
      liquidAfterLiabilitiesCents: 122_500,
    });
  });

  test("uses a savings or HYSA current balance when the bank sends a placeholder zero available balance", () => {
    expect(
      calculateLiquidMoney([
        { type: "savings", isAsset: true, currentBalanceCents: 545_199, availableBalanceCents: 0 },
        { type: "hysa", isAsset: true, currentBalanceCents: 120_000, availableBalanceCents: 0 },
      ]),
    ).toEqual({
      liquidAssetsCents: 665_199,
      liabilitiesCents: 0,
      liquidAfterLiabilitiesCents: 665_199,
    });
  });

  test("can represent a negative liquid-after-liabilities position", () => {
    expect(calculateLiquidMoney([
      { type: "cash", isAsset: true, currentBalanceCents: 1_000, availableBalanceCents: null },
      { type: "loan", isAsset: false, currentBalanceCents: 2_500, availableBalanceCents: null },
    ]).liquidAfterLiabilitiesCents).toBe(-1_500);
  });
});
