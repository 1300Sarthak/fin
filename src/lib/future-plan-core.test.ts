import { describe, expect, test } from "bun:test";
import { DEFAULT_FUTURE_PLAN, dateForMilestone, projectFuturePlan, valueAtDate } from "./future-plan-core";

describe("future planning projection", () => {
  test("adds contributions and exposes quarterly points", () => {
    const points = projectFuturePlan({ ...DEFAULT_FUTURE_PLAN, annualReturn: 0, annualContribution: 12000 }, 1);
    expect(points).toHaveLength(5);
    // Synthetic inputs fund twelve monthly contributions.
    expect(points.at(-1)?.netWorth).toBeCloseTo(12000, 0);
  });
  test("calculates a milestone and a dated projection", () => {
    const input = { ...DEFAULT_FUTURE_PLAN, annualReturn: 0, annualContribution: 12000 };
    expect(valueAtDate(input, "2026-12-31")).toBeGreaterThan(11000);
    expect(dateForMilestone(input, 12000)).not.toBeNull();
  });
});
