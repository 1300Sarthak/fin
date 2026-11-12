import type { NetWorthPoint } from "@/lib/networth";
import type { HistoryMilestone } from "@/lib/milestones";

/**
 * Every net-worth figure the app knows, oldest first, for the zoomable chart:
 * the hand-recorded checkpoints that predate synced history, then the daily
 * series (transaction-reconstructed before `realFrom`, snapshot-backed after).
 *
 * The daily series alone starts at the first synced transaction, which is why
 * "Max" used to stop in 2026 while the checkpoints go back to 2025.
 */
export type TimelineKind = "manual" | "estimated" | "actual";
export type TimelinePoint = {
  date: string;
  cents: number;
  kind: TimelineKind;
  /** A checkpoint recorded by hand on a day the daily series also covers. */
  manualCents?: number;
};
export type NetWorthTimeline = {
  points: TimelinePoint[];
  /** First snapshot-backed day; null when no day is complete. */
  realFrom: string | null;
  /** First day of the daily series (synced history). */
  seriesFrom: string | null;
  /** Whether hand-recorded checkpoints are part of this view. */
  withManual: boolean;
};

export function mergeTimeline(series: NetWorthPoint[], realFrom: string | null, milestones: Pick<HistoryMilestone, "date" | "totalCents">[]): NetWorthTimeline {
  const seriesFrom = series[0]?.date ?? null;
  const manual = [...milestones].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(manual.map((m) => [m.date, m.totalCents]));
  const points: TimelinePoint[] = [
    ...manual.filter((m) => seriesFrom === null || m.date < seriesFrom).map((m) => ({ date: m.date, cents: m.totalCents, kind: "manual" as const })),
    ...series.map((p): TimelinePoint => {
      const kind = realFrom !== null && p.date >= realFrom ? "actual" : "estimated";
      const recorded = byDate.get(p.date);
      return recorded === undefined ? { date: p.date, cents: p.net, kind } : { date: p.date, cents: p.net, kind, manualCents: recorded };
    }),
  ];
  return { points, realFrom, seriesFrom, withManual: manual.length > 0 };
}
