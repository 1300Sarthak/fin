import { describe, expect, test } from "bun:test";
import { buildPaychecks, californiaTax, computeTakeHome, reconstructPayroll, seSetAside, solveGross, withholdingFor, type PayLeg, type TakeHomeInput } from "./take-home";

const base: TakeHomeInput = { filingStatus: "single", w2GrossCents: 0, pretaxDeferralsCents: 0, seGrossCents: 0, seExpensesCents: 0, nontaxableCents: 0, federalWithheldCents: null };

describe("californiaTax (FTB 2026 schedule X)", () => {
  test("bracket bases match the published schedule", () => {
    expect(californiaTax(1_145_600, "single").taxCents).toBe(11_456);
    expect(californiaTax(7_519_700, "single")).toEqual({ taxCents: 331_088, marginalRate: 0.08 });
    expect(californiaTax(38_410_900, "single").taxCents).toBe(3_203_970);
  });
  test("mental health surcharge over $1M", () => {
    expect(californiaTax(110_000_000, "single").marginalRate).toBeCloseTo(0.133);
  });
});

describe("computeTakeHome", () => {
  test("full year at $110k W-2, single", () => {
    const t = computeTakeHome({ ...base, w2GrossCents: 11_000_000 });
    // Federal: 110,000 - 16,100 = 93,900 taxable -> 1,240 + 4,560 + 22% of 43,500 = 15,370.
    expect(t.federal.taxableCents).toBe(9_390_000);
    expect(t.federal.incomeTaxCents).toBe(1_537_000);
    expect(t.federal.marginalRate).toBe(0.22);
    expect(t.fica.totalCents).toBe(841_500); // 7.65%
    // CA: 110,000 - 5,900 = 104,100 -> 3,310.88 + 9.3% of 28,903 = 5,998.86, less the $158 credit.
    expect(t.california.incomeTaxCents).toBe(584_086);
    expect(t.california.sdiCents).toBe(143_000); // 1.3%, no wage cap
    expect(t.totalTaxCents).toBe(1_537_000 + 841_500 + 584_086 + 143_000);
    expect(t.keepCents).toBe(11_000_000 - t.totalTaxCents);
    expect(t.federalOwedCents).toBeNull();
  });

  test("pre-tax deferrals cut income tax but not FICA or SDI", () => {
    const a = computeTakeHome({ ...base, w2GrossCents: 11_000_000 });
    const b = computeTakeHome({ ...base, w2GrossCents: 11_000_000, pretaxDeferralsCents: 1_000_000 });
    expect(b.federal.incomeTaxCents).toBe(a.federal.incomeTaxCents - 220_000);
    expect(b.fica.totalCents).toBe(a.fica.totalCents);
    expect(b.california.sdiCents).toBe(a.california.sdiCents);
  });

  test("1099 income: SE tax, half-SE deduction, QBI; nontaxable is kept but never taxed", () => {
    const t = computeTakeHome({ ...base, w2GrossCents: 6_000_000, seGrossCents: 500_000, seExpensesCents: 100_000, nontaxableCents: 50_000 });
    expect(t.seNetProfitCents).toBe(400_000);
    expect(t.seTax.netEarningsCents).toBe(369_400);
    expect(t.seTax.totalCents).toBe(56_519);
    expect(t.federal.agiCents).toBe(6_000_000 + 400_000 - 28_260);
    expect(t.federal.qbiDeductionCents).toBe(Math.round(0.2 * (400_000 - 28_260)));
    const without = computeTakeHome({ ...base, w2GrossCents: 6_000_000, seGrossCents: 500_000, seExpensesCents: 100_000 });
    expect(t.totalTaxCents).toBe(without.totalTaxCents);
    expect(t.keepCents).toBe(without.keepCents + 50_000);
  });

  test("owed vs withheld only when Box 2 is known", () => {
    const t = computeTakeHome({ ...base, w2GrossCents: 11_000_000, federalWithheldCents: 1_400_000 });
    expect(t.federalOwedCents).toBe(1_537_000 - 1_400_000);
  });

  test("set-aside is the extra tax the 1099 income causes", () => {
    const s = seSetAside({ ...base, w2GrossCents: 6_500_000, seGrossCents: 500_000 });
    // 22% federal + 8% CA + ~14% SE tax, less the half-SE and QBI deductions.
    expect(s.rate!).toBeGreaterThan(0.33);
    expect(s.rate!).toBeLessThan(0.4);
    expect(seSetAside({ ...base, w2GrossCents: 6_500_000 }).rate).toBeNull();
  });
});


const payroll = { status: "single" as const, periods: 26, caAllowances: 1, pretax401kCents: 0, roth401kCents: 0, hsaPayrollCents: 0 };

describe("withholdingFor (Pub 15-T 2026 / DE 44 2026)", () => {
  test("a $4,230.77 biweekly check, single, W-4 2020+", () => {
    const w = withholdingFor(423_077, payroll);
    // Federal: 4,230.77 × 26 = 110,000.02 − 8,600 = 101,400.02 → 5,800 + 22% × 43,500.02 = 15,370.00 / 26 = 591.15
    expect(w.federalCents).toBe(59_115);
    expect(w.ficaCents).toBe(32_365); // 7.65%
    // CA: 110,000.02 − 5,706 = 104,294.02 → 3,522.17 + 10.23% × 31,570.02 = 6,751.78 − 168.30 = 6,583.48 / 26 = 253.21
    expect(w.caCents).toBe(25_321);
    expect(w.sdiCents).toBe(5_500);
    expect(w.netCents).toBe(423_077 - 59_115 - 32_365 - 25_321 - 5_500);
  });
  test("below the CA low-income exemption nothing is withheld for California", () => {
    expect(withholdingFor(70_000, payroll).caCents).toBe(0);
  });
  test("pre-tax 401(k) lowers income-tax withholding, not FICA", () => {
    const a = withholdingFor(423_077, payroll), b = withholdingFor(423_077, { ...payroll, pretax401kCents: 50_000 });
    expect(b.federalCents).toBeLessThan(a.federalCents);
    expect(b.ficaCents).toBe(a.ficaCents);
  });
  test("solveGross inverts withholdingFor to the cent", () => {
    const net = withholdingFor(423_077, payroll).netCents;
    expect(Math.abs(solveGross(net, payroll).grossCents - 423_077)).toBeLessThanOrEqual(2);
    const withK = { ...payroll, pretax401kCents: 243_800 };
    expect(Math.abs(solveGross(withholdingFor(500_000, withK).netCents, withK).grossCents - 500_000)).toBeLessThanOrEqual(2);
  });
});

describe("buildPaychecks", () => {
  const leg = (txnId: number, date: string, cents: number, kind: PayLeg["kind"]): PayLeg => ({ txnId, date, cents, kind, account: kind, accountId: 1 });
  test("split deposits, a Roth IRA direct deposit, HSA and a late 401(k) post land on one paycheck", () => {
    const { paychecks, stray } = buildPaychecks([
      leg(1, "2026-10-28", 59_287, "bank"), leg(2, "2026-10-29", 59_306, "bank"), leg(3, "2026-10-28", 59_288, "hsa"), leg(4, "2026-11-01", 243_800, "401k"),
      leg(5, "2026-07-29", 319_678, "roth-ira"), leg(6, "2026-09-08", 10_000, "hsa"),
    ]);
    expect(paychecks.map((p) => [p.date, p.netCents, p.hsaCents, p.deferral401kCents])).toEqual([["2026-07-29", 319_678, 0, 0], ["2026-10-28", 118_593, 59_288, 243_800]]);
    expect(stray.map((l) => l.txnId)).toEqual([6]);
  });
});

describe("reconstructPayroll", () => {
  const a = { annualSalaryCents: 11_000_000, fullTimeStart: "2026-10-05", periods: 26, caAllowances: 1, k401Type: "pretax" as const, k401Pct: null, hsaPayroll: false, projectRest: true };
  test("a full-time check that nets exactly a salary check has zero residual, and the rest of the year is projected", () => {
    const net = withholdingFor(423_077, payroll).netCents;
    const p = reconstructPayroll([{ date: "2026-10-28", legs: [], netCents: net, deferral401kCents: 0, hsaCents: 0 }], a, "single", 2026, "2026-11-12");
    expect(Math.abs(p.paychecks[0].residualCents!)).toBeLessThanOrEqual(2);
    expect(p.remainingPaydays).toEqual(["2026-11-11", "2026-11-25", "2026-12-09", "2026-12-23"]);
    expect(p.projected.grossCents).toBe(4 * 423_077);
  });
  test("a check from the last week is still posting: not compared, counted at the salary rate", () => {
    const p = reconstructPayroll([{ date: "2026-11-10", legs: [], netCents: 50_000, deferral401kCents: 0, hsaCents: 0 }], a, "single", 2026, "2026-11-12");
    expect(p.paychecks[0]).toMatchObject({ incomplete: true, residualCents: null });
    expect(p.ytd.grossCents).toBe(423_077);
  });
});

describe("lump 401(k) deposits (regression: one deposit after a payday with none)", () => {
  const leg = (txnId: number, date: string, cents: number, kind: PayLeg["kind"]): PayLeg => ({ txnId, date, cents, kind, account: kind, accountId: 1 });
  const legs = [
    leg(484, "2026-08-27", 162_068, "bank"), leg(511, "2026-08-30", 23_071, "401k"),
    leg(904, "2026-10-13", 276_897, "bank"), // no 401(k) of its own
    leg(900, "2026-10-28", 177_881, "bank"), leg(874, "2026-11-01", 243_800, "401k"), // the lump
  ];
  test("the lump is split across every payday since the previous 401(k) deposit", () => {
    const { paychecks } = buildPaychecks(legs);
    expect(paychecks.map((p) => [p.date, p.deferral401kCents])).toEqual([["2026-08-27", 23_071], ["2026-10-13", 121_900], ["2026-10-28", 121_900]]);
    expect(paychecks[2].legs.find((l) => l.txnId === 874)?.share).toEqual({ totalCents: 243_800, paydays: 2 });
  });
  test("future paychecks defer at a per-check rate, not the lump", () => {
    const { paychecks } = buildPaychecks(legs);
    const a = { annualSalaryCents: 11_000_000, fullTimeStart: "2026-10-05", periods: 26, caAllowances: 1, k401Type: "pretax" as const, k401Pct: null, hsaPayroll: false, projectRest: true };
    const p = reconstructPayroll(paychecks, a, "single", 2026, "2026-11-20");
    const oct28 = p.paychecks.find((x) => x.date === "2026-10-28")!;
    expect(p.k401.rate).toBeCloseTo(121_900 / oct28.grossCents, 6);
    expect(p.k401.perCheckCents).toBeLessThan(243_800);
    expect(p.projected.deferral401kCents).toBe(p.remainingPaydays.length * p.k401.perCheckCents);
    // An explicit election wins.
    expect(reconstructPayroll(paychecks, { ...a, k401Pct: 10 }, "single", 2026, "2026-11-20").k401.perCheckCents).toBe(42_308);
  });
});
