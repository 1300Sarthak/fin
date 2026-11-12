import { describe, expect, test } from "bun:test";
import { computeSep, sepDeadline } from "./sep";

describe("computeSep", () => {
  // Illustrative: $5,400 of SE income and $1,000 of deductible expenses.
  test("$5,400 gross less $1,000 of expenses, worked by hand", () => {
    const r = computeSep({ seGrossCents: 540_000, deductibleExpensesCents: 100_000 });
    expect(r.netProfitCents).toBe(440_000);
    expect(r.netSeEarningsCents).toBe(406_340); // 4,400 × 0.9235 = 4,063.40
    expect(r.ssTaxCents).toBe(50_386); // × 12.4%
    expect(r.medicareTaxCents).toBe(11_784); // × 2.9%
    expect(r.seTaxCents).toBe(62_170);
    expect(r.halfSeTaxCents).toBe(31_085);
    expect(r.compensationCents).toBe(408_915); // 4,400 − 310.85
    expect(r.sep.maxCents).toBe(81_783); // 20% of 4,089.15
    // Solo 401(k): the employee piece is limited by pay left after the employer piece.
    expect(r.solo401k.employeeCents).toBe(327_132);
    expect(r.solo401k.totalCents).toBe(408_915);
    expect(r.solo401k.w2Known).toBe(false);
  });

  test("$5,400 gross with no expenses", () => {
    const r = computeSep({ seGrossCents: 540_000, deductibleExpensesCents: 0 });
    expect(r.netSeEarningsCents).toBe(498_690);
    expect(r.seTaxCents).toBe(61_838 + 14_462);
    expect(r.halfSeTaxCents).toBe(38_150);
    expect(r.sep.maxCents).toBe(100_370);
  });

  test("W-2 wages at the SS wage base leave only Medicare", () => {
    const r = computeSep({ seGrossCents: 540_000, deductibleExpensesCents: 0, w2SsWagesCents: 18_450_000 });
    expect(r.ssTaxCents).toBe(0);
    expect(r.seTaxCents).toBe(14_462);
  });

  test("high income hits the SS base and the 415(c) dollar limit", () => {
    const r = computeSep({ seGrossCents: 50_000_000, deductibleExpensesCents: 0 });
    expect(r.ssTaxCents).toBe(2_287_800);
    expect(r.medicareTaxCents).toBe(1_339_075);
    expect(r.halfSeTaxCents).toBe(1_813_438);
    expect(r.sep.byRateCents).toBe(9_637_312);
    expect(r.sep.byCompCapCents).toBe(9_000_000);
    expect(r.sep.maxCents).toBe(7_200_000);
  });

  test("W-2 deferrals shrink the shared 402(g) room; 415(c) caps the plan", () => {
    const r = computeSep({ seGrossCents: 50_000_000, deductibleExpensesCents: 0, w2DeferralsCents: 2_000_000 });
    expect(r.solo401k.deferralRoomCents).toBe(450_000);
    expect(r.solo401k.employeeCents).toBe(450_000);
    expect(r.solo401k.totalCents).toBe(7_200_000);
  });

  test("under $400 of SE earnings owes no SE tax; losses give no room", () => {
    const small = computeSep({ seGrossCents: 40_000, deductibleExpensesCents: 0 });
    expect(small.seTaxCents).toBe(0);
    expect(small.sep.maxCents).toBe(8_000);
    const loss = computeSep({ seGrossCents: 10_000, deductibleExpensesCents: 50_000 });
    expect(loss.seTaxCents).toBe(0);
    expect(loss.sep.maxCents).toBe(0);
    expect(loss.solo401k.totalCents).toBe(0);
  });

  test("zero income is all zeros", () => {
    const r = computeSep({ seGrossCents: 0, deductibleExpensesCents: 0 });
    expect([r.seTaxCents, r.sep.maxCents, r.solo401k.totalCents]).toEqual([0, 0, 0]);
  });

  test("W-2 figures from the paychecks: same SEP max below the wage base, smaller 402(g) room, sources labelled", () => {
    const bare = computeSep({ seGrossCents: 540_000, deductibleExpensesCents: 104_000 });
    const r = computeSep({
      seGrossCents: 540_000, deductibleExpensesCents: 104_000, w2SsWagesCents: 5_000_000, w2DeferralsCents: 800_000,
      w2Sources: { ssWages: "from your paychecks", deferrals: "from your paychecks: $3,000.00 deferred so far" },
    });
    expect(r.ssTaxCents).toBe(bare.ssTaxCents);
    expect(r.sep.maxCents).toBe(bare.sep.maxCents);
    expect(r.sep.maxCents).toBe(81_039);
    expect(r.solo401k.deferralRoomCents).toBe(2_450_000 - 800_000);
    expect(r.w2Sources).toEqual({ ssWages: "from your paychecks", deferrals: "from your paychecks: $3,000.00 deferred so far" });
    expect(r.notes.join(" ")).toContain("(from your paychecks: $3,000.00 deferred so far)");
    expect(r.notes.join(" ")).not.toContain("not entered");
    // An unknown deferral carries no source, whatever label was passed.
    expect(computeSep({ seGrossCents: 540_000, deductibleExpensesCents: 0, w2Sources: { deferrals: "x" } }).w2Sources.deferrals).toBeNull();
  });

  test("W-2 wages that eat most of the wage base cut SS tax and so raise the SEP max", () => {
    const r = computeSep({ seGrossCents: 540_000, deductibleExpensesCents: 0, w2SsWagesCents: 18_200_000 });
    expect(r.ssTaxableCents).toBe(250_000);
    expect(r.ssTaxCents).toBe(31_000);
    expect(r.sep.maxCents).toBeGreaterThan(100_370);
  });

  test("deadline is the extended return due date", () => {
    expect(sepDeadline(2026)).toMatchObject({ withoutExtension: "2027-04-15", withExtension: "2027-10-15" });
  });
});
