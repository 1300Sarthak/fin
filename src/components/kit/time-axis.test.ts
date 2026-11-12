import { describe, expect, test } from "bun:test";
import { clampWindow, dayOf, isoOf, longDate, nearestIndex, niceTicks, timeTicks, type Tick } from "./time-axis";

const MIN_GAP = 56;
const px = (t: Tick, start: number, end: number, width: number) => ((t.day - start) / (end - start)) * width;
function assertNoOverlap(ticks: Tick[], start: number, end: number, width: number) {
  for (let i = 1; i < ticks.length; i++) {
    expect(px(ticks[i], start, end, width) - px(ticks[i - 1], start, end, width)).toBeGreaterThanOrEqual(MIN_GAP);
  }
  for (const t of ticks) {
    expect(px(t, start, end, width)).toBeGreaterThanOrEqual(16);
    expect(px(t, start, end, width)).toBeLessThanOrEqual(width - 16);
  }
}

describe("day numbers", () => {
  test("round-trip and long date", () => {
    expect(isoOf(dayOf("2026-10-24"))).toBe("2026-10-24");
    expect(longDate(dayOf("2026-10-24"))).toBe("Sat, Oct 24, 2026");
    expect(longDate(dayOf("2024-10-24"))).toBe("Thu, Oct 24, 2024");
  });
});

describe("timeTicks", () => {
  test("2 days: every day, as M/D", () => {
    const s = dayOf("2026-11-11");
    const e = dayOf("2026-11-12");
    const ticks = timeTicks(s - 0.5, e + 0.5, 1200);
    expect(ticks.map((t) => t.label)).toEqual(["11/11", "11/12"]);
    expect(ticks.every((t) => t.level === "day")).toBe(true);
    assertNoOverlap(ticks, s - 0.5, e + 0.5, 1200);
  });

  test("3 weeks: daily on desktop, weekly 10/24-style on a phone", () => {
    const s = dayOf("2026-10-05");
    const e = dayOf("2026-10-26");
    const wide = timeTicks(s, e, 1300);
    expect(wide).toHaveLength(20);
    expect(wide.map((t) => t.label)).toContain("10/24");
    assertNoOverlap(wide, s, e, 1300);

    const narrow = timeTicks(s, e, 330);
    expect(narrow.map((t) => t.label)).toEqual(["10/12", "10/19"]); // Mondays
    assertNoOverlap(narrow, s, e, 330);
  });

  test("7 months: month names, Jan becomes the year", () => {
    const s = dayOf("2026-09-15");
    const e = dayOf("2027-04-15");
    const ticks = timeTicks(s, e, 1200);
    expect(ticks.map((t) => t.label)).toEqual(["Oct 2026", "Nov", "Dec", "2027", "Feb", "Mar", "Apr"]); // first label carries its year
    expect(ticks.find((t) => t.label === "2027")?.level).toBe("year");
    assertNoOverlap(ticks, s, e, 1200);

    const narrow = timeTicks(s, e, 330);
    expect(narrow.map((t) => t.label)).toContain("2027");
    assertNoOverlap(narrow, s, e, 330);
  });

  test("3 years: year boundaries always shown, months between when there is room", () => {
    const s = dayOf("2024-02-06");
    const e = dayOf("2027-02-05");
    const wide = timeTicks(s, e, 1200);
    const years = wide.filter((t) => t.level === "year").map((t) => t.label);
    expect(years).toEqual(["2025", "2026", "2027"]);
    expect(wide.some((t) => t.level === "month")).toBe(true);
    assertNoOverlap(wide, s, e, 1200);

    const narrow = timeTicks(s, e, 330);
    expect(narrow.filter((t) => t.level === "year").map((t) => t.label)).toEqual(["2025", "2026"]);
    assertNoOverlap(narrow, s, e, 330);
  });

  test("a weekly zoom across New Year still marks the year", () => {
    const s = dayOf("2026-12-10");
    const e = dayOf("2027-01-20");
    const ticks = timeTicks(s, e, 400);
    expect(ticks.map((t) => t.label)).toContain("2027");
    assertNoOverlap(ticks, s, e, 400);
  });

  test("degenerate windows return nothing", () => {
    expect(timeTicks(5, 5, 400)).toEqual([]);
    expect(timeTicks(0, 10, 0)).toEqual([]);
  });
});

describe("helpers", () => {
  test("niceTicks steps by 1/2/2.5/5", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1_234_500, 1_890_000, 4)).toEqual([1_400_000, 1_600_000, 1_800_000]);
  });

  test("clampWindow keeps length and stays inside", () => {
    expect(clampWindow(-5, 5, 0, 100)).toEqual([0, 10]);
    expect(clampWindow(95, 110, 0, 100)).toEqual([85, 100]);
    expect(clampWindow(10, 10.2, 0, 100, 1)).toEqual([10, 11]);
    expect(clampWindow(-50, 500, 0, 100)).toEqual([0, 100]);
  });

  test("nearestIndex", () => {
    expect(nearestIndex([1, 5, 9], 6.9)).toBe(1);
    expect(nearestIndex([1, 5, 9], 7.1)).toBe(2);
    expect(nearestIndex([1, 5, 9], -3)).toBe(0);
  });
});
