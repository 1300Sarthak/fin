import { getNetWorthSeries, type ResolvedInclusion } from "@/lib/networth";
import { getAccountTotals } from "@/lib/queries";
import { getMilestones } from "@/lib/milestones";
import { mergeTimeline, type NetWorthTimeline } from "@/lib/net-worth-timeline-core";

export type { NetWorthTimeline, TimelinePoint, TimelineKind } from "@/lib/net-worth-timeline-core";

/**
 * The full timeline for an inclusion set. Checkpoints are whole-picture totals,
 * so they only join the line when the account picker is on its baseline; a
 * hand-picked subset of accounts shows synced history alone.
 */
export async function getNetWorthTimeline(inclusion: ResolvedInclusion): Promise<NetWorthTimeline> {
  const ids = [...inclusion.includeIds];
  const [totals, milestones] = await Promise.all([getAccountTotals(ids), inclusion.usedOverride ? Promise.resolve([]) : getMilestones()]);
  const series = await getNetWorthSeries({ range: "MAX", includeIds: inclusion.includeIds, totals, allActiveIds: inclusion.allActiveIds });
  return mergeTimeline(series.points, series.realFrom, milestones);
}
