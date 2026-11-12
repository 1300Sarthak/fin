import { test, expect, describe } from "bun:test";
import { simulateWaterfall, type PlannerGoal } from "./planner-core";

const goals = (ef: number, roth: number): PlannerGoal[] => [
  { id: 1, name: "Emergency Fund", type: "emergency_fund", priority: 0, targetCents: 500000, currentCents: ef },
  { id: 2, name: "Roth IRA", type: "retirement", priority: 1, targetCents: 750000, currentCents: roth },
  { id: 3, name: "Invest", type: "taxable_invest", priority: 2, targetCents: 0, currentCents: 0 },
];

describe("simulateWaterfall", () => {
  test("funds goals in priority order with cascade", () => {
    const r = simulateWaterfall(goals(200000, 0), 100000); // $2k EF, $1k/mo
    const [ef, roth, invest] = r.goals;
    expect(ef.monthsToComplete).toBe(3); // needs $3k at $1k/mo
    expect(roth.monthsToComplete).toBe(11); // then $7.5k at $1k/mo
    expect(invest.monthsToComplete).toBeNull(); // open-ended
    expect(ef.monthlyAllocationCents).toBe(100000); // all surplus to EF first
    expect(roth.monthlyAllocationCents).toBe(0);
    expect(r.monthsToAllFunded).toBe(11);
  });

  test("overflows to the next goal once one is full", () => {
    // EF already full -> surplus goes to Roth in month 1
    const r = simulateWaterfall(goals(500000, 0), 100000);
    const [ef, roth] = r.goals;
    expect(ef.isComplete).toBe(true);
    expect(ef.monthsToComplete).toBeNull();
    expect(roth.monthlyAllocationCents).toBe(100000);
  });

  test("open-ended bucket absorbs remainder when targets are met", () => {
    const r = simulateWaterfall(goals(500000, 750000), 100000);
    const invest = r.goals[2];
    expect(invest.monthlyAllocationCents).toBe(100000);
    expect(r.monthsToAllFunded).toBe(0);
  });

  test("no surplus -> no progress", () => {
    const r = simulateWaterfall(goals(0, 0), 0);
    expect(r.goals[0].monthsToComplete).toBeNull();
    expect(r.goals[0].monthlyAllocationCents).toBe(0);
  });
});

// The real goal set on 2026-11-12: an open-ended Invest bucket stored at
// priority 2, ahead of three tax-year goals with deadlines.
const REAL: PlannerGoal[] = [
  { id: 1, name: "Emergency Fund", type: "emergency_fund", priority: 0, targetCents: 1_500_000, currentCents: 1_078_580 },
  { id: 3, name: "Invest (Stocks & Crypto)", type: "taxable_invest", priority: 2, targetCents: 0, currentCents: 698_145 },
  { id: 7, name: "Max family HSA 2026", type: "retirement", priority: 3, targetCents: 875_000, currentCents: 69_288, closesAfterMonths: 6 },
  { id: 8, name: "Student loan interest 2026", type: "debt_payoff", priority: 4, targetCents: 250_000, currentCents: 0, closesAfterMonths: 2 },
  { id: 10, name: "Max Roth IRA 2027", type: "retirement", priority: 6, targetCents: 750_000, currentCents: 0, opensInMonths: 3, closesAfterMonths: 18 },
];
const byName = (r: ReturnType<typeof simulateWaterfall>, n: string) => r.goals.find((g) => g.name.startsWith(n))!;

describe("open-ended buckets and deadlines", () => {
  test("$10,000/mo: earliest deadline first, Invest gets nothing until every open target is full", () => {
    const r = simulateWaterfall(REAL, 1_000_000);
    expect(r.goals.map((g) => g.id)).toEqual([8, 7, 10, 1, 3]);
    expect(byName(r, "Student loan").monthlyAllocationCents).toBe(250_000);
    expect(byName(r, "Max family HSA").monthlyAllocationCents).toBe(750_000);
    expect(byName(r, "Invest").monthlyAllocationCents).toBe(0);
    expect(byName(r, "Student loan").monthsToComplete).toBe(1);
    expect(byName(r, "Max family HSA").monthsToComplete).toBe(2);
    expect(byName(r, "Emergency").monthsToComplete).toBe(2);
    expect(byName(r, "Max Roth IRA 2027").monthsToComplete).toBe(3);
    expect(r.missedDeadlines).toBe(0);
    expect(r.monthsToAllFunded).toBe(3);
  });

  test("$5,000/mo: the Dec 31 loan goal beats the April HSA, and both are met", () => {
    const r = simulateWaterfall(REAL, 500_000);
    expect(byName(r, "Student loan").monthsToComplete).toBe(1);
    expect(byName(r, "Max family HSA").monthsToComplete).toBe(3);
    expect(byName(r, "Max Roth IRA 2027").monthsToComplete).toBe(4);
    expect(byName(r, "Emergency").monthsToComplete).toBe(5);
    expect(r.missedDeadlines).toBe(0);
    expect(r.monthsToAllFunded).toBe(5);
  });

  test("$500/mo: never claims all targets funded when deadlines are missed", () => {
    const r = simulateWaterfall(REAL, 50_000);
    expect(r.pendingTargets).toBe(4);
    expect(r.missedDeadlines).toBe(3);
    expect(r.monthsToAllFunded).toBe(0);
    expect(byName(r, "Emergency").monthsToComplete).toBe(27);
    expect(byName(r, "Invest").monthlyAllocationCents).toBe(0);
  });

  test("an undated goal waits behind dated ones regardless of priority; priority orders the undated", () => {
    const r = simulateWaterfall([
      { id: 1, name: "Undated A", type: "custom", priority: 0, targetCents: 100_000, currentCents: 0 },
      { id: 2, name: "Dated", type: "custom", priority: 9, targetCents: 100_000, currentCents: 0, closesAfterMonths: 6 },
      { id: 3, name: "Undated B", type: "custom", priority: 1, targetCents: 100_000, currentCents: 0 },
    ], 100_000);
    expect(r.goals.map((g) => g.name)).toEqual(["Dated", "Undated A", "Undated B"]);
  });

  test("equal priority: the nearer deadline is funded first", () => {
    const r = simulateWaterfall([
      { id: 1, name: "Later", type: "custom", priority: 1, targetCents: 100_000, currentCents: 0, closesAfterMonths: 12 },
      { id: 2, name: "Sooner", type: "custom", priority: 1, targetCents: 100_000, currentCents: 0, closesAfterMonths: 2 },
    ], 100_000);
    expect(byName(r, "Sooner").monthsToComplete).toBe(1);
    expect(byName(r, "Later").monthsToComplete).toBe(2);
  });

  test("an open-ended bucket still takes the surplus in months no target is open", () => {
    const r = simulateWaterfall([
      { id: 1, name: "Roth next year", type: "retirement", priority: 0, targetCents: 100_000, currentCents: 0, opensInMonths: 3 },
      { id: 2, name: "Invest", type: "taxable_invest", priority: 0, targetCents: 0, currentCents: 0 },
    ], 50_000);
    expect(byName(r, "Invest").monthlyAllocationCents).toBe(50_000);
    expect(byName(r, "Roth next year").monthsToComplete).toBe(4);
  });
});
