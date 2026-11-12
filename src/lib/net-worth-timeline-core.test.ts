import { describe, expect, test } from "bun:test";
import { mergeTimeline } from "./net-worth-timeline-core";

describe("mergeTimeline", () => {
  const series = [
    { date: "2026-03-27", net: 1000 },
    { date: "2026-03-28", net: 1100 },
    { date: "2026-05-29", net: 1200 },
  ];
  const milestones = [
    { date: "2025-06-15", totalCents: 500 },
    { date: "2025-02-06", totalCents: 300 },
    { date: "2026-03-28", totalCents: 1150 },
  ];

  test("older checkpoints lead the line; in-span ones annotate the daily point", () => {
    const t = mergeTimeline(series, "2026-05-29", milestones);
    expect(t.points.map((p) => [p.date, p.kind])).toEqual([
      ["2025-02-06", "manual"],
      ["2025-06-15", "manual"],
      ["2026-03-27", "estimated"],
      ["2026-03-28", "estimated"],
      ["2026-05-29", "actual"],
    ]);
    expect(t.points[3].manualCents).toBe(1150);
    expect(t.points[3].cents).toBe(1100);
    expect(t.seriesFrom).toBe("2026-03-27");
    expect(t.withManual).toBe(true);
  });

  test("no complete snapshot day means the whole series is estimated", () => {
    const t = mergeTimeline(series, null, []);
    expect(t.points.every((p) => p.kind === "estimated")).toBe(true);
    expect(t.withManual).toBe(false);
  });

  test("checkpoints alone still make a line", () => {
    const t = mergeTimeline([], null, milestones);
    expect(t.points.map((p) => p.kind)).toEqual(["manual", "manual", "manual"]);
    expect(t.seriesFrom).toBeNull();
  });
});
