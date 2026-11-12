import { describe, expect, test } from "bun:test";
import { bookingTips, defaultValuation, pointsVsCash } from "./travel-advisor";

describe("pointsVsCash", () => {
  // A hotel night via Chase Travel: $104 or 9,436 pts.
  const laQuinta = { cashCents: 10_400, points: 9_436, programValueHundredthsCpp: 100 };

  test("achieves 1.10c per point", () => {
    expect(pointsVsCash(laQuinta).achievedHundredthsCpp).toBe(110);
  });

  test("Freedom-only points at 1.0c: 1.10c beats cash net of 3% back", () => {
    const r = pointsVsCash(laQuinta);
    expect(r.pointsCostCents).toBe(9_436);
    expect(r.cardBackCents).toBe(312);
    expect(r.effectiveCashCents).toBe(10_088);
    expect(r.verdict).toBe("use points");
  });

  test("lost hotel earning on a direct booking narrows it to roughly equal", () => {
    const r = pointsVsCash({ ...laQuinta, earnsLoyaltyIfDirect: true });
    expect(r.loyaltyCents).toBe(520);
    expect(r.verdict).toBe("roughly equal");
    expect(r.reason).toContain("loyalty");
  });

  test("points worth 1.7c elsewhere should not be spent at 1.10c", () => {
    expect(pointsVsCash({ ...laQuinta, programValueHundredthsCpp: 170 }).verdict).toBe("pay cash");
  });

  test("refundable cash raises the bar for points", () => {
    expect(pointsVsCash({ ...laQuinta, refundableCash: true }).verdict).toBe("roughly equal");
  });

  test("rejects zero or negative inputs", () => {
    expect(() => pointsVsCash({ ...laQuinta, points: 0 })).toThrow();
    expect(() => pointsVsCash({ ...laQuinta, cashCents: -1 })).toThrow();
  });
});

describe("defaultValuation", () => {
  test("plain Chase is Freedom-only; Sapphire is its own row", () => {
    expect(defaultValuation("Chase Ultimate Rewards")?.hundredthsCpp).toBe(100);
    expect(defaultValuation("Chase Sapphire Preferred")?.hundredthsCpp).toBe(170);
  });
  test("La Quinta maps to Wyndham; unknown is undefined", () => {
    expect(defaultValuation("La Quinta Returns")?.name).toContain("Wyndham");
    expect(defaultValuation("Mystery Club")).toBeUndefined();
  });
});

describe("bookingTips", () => {
  const held = [{ name: "Chase Ultimate Rewards", kind: "card" as const }];
  test("hotel without a hotel program: join and book direct, pay with Robinhood", () => {
    const tips = bookingTips(held, "hotel");
    expect(tips.some((t) => t.includes("Join the hotel's free program"))).toBe(true);
    expect(tips.some((t) => t.includes("Robinhood Gold (3% back)"))).toBe(true);
    expect(tips.some((t) => t.includes("Long term"))).toBe(true);
  });
  test("abroad swaps the Robinhood tip for the FX warning", () => {
    const tips = bookingTips(held, "hotel", { abroad: true });
    expect(tips.some((t) => t.includes("3% back"))).toBe(false);
    expect(tips.some((t) => t.includes("FX"))).toBe(true);
  });
  test("a held hotel program is named; a Sapphire drops the long-term nudge", () => {
    const tips = bookingTips([...held, { name: "Chase Sapphire Preferred", kind: "card" }, { name: "Wyndham Rewards", kind: "hotel" }], "hotel");
    expect(tips[0]).toContain("Wyndham Rewards");
    expect(tips.some((t) => t.includes("Long term") || t.includes("Freedom-only"))).toBe(false);
  });
});
