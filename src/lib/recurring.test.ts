import { test, expect, describe } from "bun:test";
import { analyzeSeries, statusOf } from "./recurring";

const DAY = 86_400_000;

function series(startISO: string, n: number, intervalDays: number, amountCents: number) {
  const start = new Date(startISO).getTime();
  return Array.from({ length: n }, (_, i) => ({
    postedAt: new Date(start + i * intervalDays * DAY),
    amountCents,
  }));
}

describe("analyzeSeries", () => {
  test("detects a monthly subscription", () => {
    const a = analyzeSeries(series("2026-01-01", 6, 30, -1599));
    expect(a).not.toBeNull();
    expect(a!.cadence).toBe("monthly");
    expect(a!.expectedAmountCents).toBe(1599);
    expect(a!.occurrences).toBe(6);
  });

  test("detects weekly cadence", () => {
    expect(analyzeSeries(series("2026-01-01", 5, 7, -500))!.cadence).toBe("weekly");
  });

  test("ignores fewer than 3 occurrences", () => {
    expect(analyzeSeries(series("2026-01-01", 2, 30, -1599))).toBeNull();
  });

  test("ignores variable amounts (e.g. groceries)", () => {
    const t = [-2500, -9000, -4000, -12000].map((a, i) => ({
      postedAt: new Date(new Date("2026-01-01").getTime() + i * 30 * DAY),
      amountCents: a,
    }));
    expect(analyzeSeries(t)).toBeNull();
  });

  test("ignores irregular intervals", () => {
    const days = [0, 3, 40, 95];
    const t = days.map((d) => ({
      postedAt: new Date(new Date("2026-01-01").getTime() + d * DAY),
      amountCents: -1599,
    }));
    expect(analyzeSeries(t)).toBeNull();
  });
});

describe("statusOf", () => {
  const base = {
    cadence: "monthly" as const,
    expectedAmountCents: 1599,
    lastAmountCents: 1599,
    nextExpectedAt: new Date(Date.now() + 10 * DAY),
    occurrences: 8,
  };

  test("active when on track", () => {
    expect(statusOf(base)).toBe("active");
  });

  test("flags a price increase", () => {
    expect(statusOf({ ...base, lastAmountCents: 1999 })).toBe("price_changed");
  });

  test("flags a missed/late charge", () => {
    expect(statusOf({ ...base, nextExpectedAt: new Date(Date.now() - 30 * DAY) })).toBe(
      "missed",
    );
  });

  test("flags a new subscription", () => {
    expect(statusOf({ ...base, occurrences: 3 })).toBe("new");
  });
});
