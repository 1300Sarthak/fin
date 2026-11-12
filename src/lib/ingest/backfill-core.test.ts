import { describe, expect, test } from "bun:test";
import { planBackfillWindows } from "./backfill-core";

describe("planBackfillWindows", () => {
  test("newest first, 45-day inclusive windows, no gaps or overlaps", () => {
    const w = planBackfillWindows("2025-01-01", "2026-03-26");
    expect(w[0]).toEqual({ start: "2026-02-10", end: "2026-03-26" });
    expect(w[w.length - 1].start).toBe("2025-01-01");
    for (let i = 1; i < w.length; i++) {
      const gap = (Date.parse(w[i - 1].start) - Date.parse(w[i].end)) / 86_400_000;
      expect(gap).toBe(1);
    }
    const total = w.reduce((n, x) => n + (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000 + 1, 0);
    expect(total).toBe((Date.parse("2026-03-26") - Date.parse("2025-01-01")) / 86_400_000 + 1);
    expect(w.every((x) => (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000 + 1 <= 45)).toBe(true);
  });

  test("a span shorter than a window is one window; reversed is none", () => {
    expect(planBackfillWindows("2026-03-01", "2026-03-10")).toEqual([{ start: "2026-03-01", end: "2026-03-10" }]);
    expect(planBackfillWindows("2026-03-11", "2026-03-10")).toEqual([]);
  });

  test("bad dates fail instead of planning nonsense", () => {
    expect(() => planBackfillWindows("2026-13-01", "2026-03-10")).toThrow();
    expect(() => planBackfillWindows("last year", "2026-03-10")).toThrow();
  });
});
