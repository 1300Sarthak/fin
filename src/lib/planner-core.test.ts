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
