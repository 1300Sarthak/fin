import { db } from "@/db";
import { netWorthMilestones, netWorthMilestoneLines } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

/**
 * The hand-kept net worth ledger (the spreadsheet's "Current Value" tab), now
 * stored in the DB so new checkpoints can be added from the app.
 *
 * Two things carried over deliberately from how the numbers were kept by hand:
 *
 * 1. `totalCents` is the RECORDED total, not a derived sum. In a hand-kept
 *    sheet the two drift apart — a checkpoint's written total and the sum of
 *    its lines can differ by a few dollars, and some checkpoints deliberately
 *    record a figure that excludes one income source. So the recorded number
 *    is authoritative and `computedCents` is exposed alongside it, letting the
 *    UI show the drift instead of silently rewriting it.
 *
 * 2. Excluded lines are kept, not dropped. "Money I get owed" was always
 *    tracked next to the total rather than inside it.
 */

export type MilestoneLine = {
  id?: number;
  label: string;
  cents: number; // signed: negative = debt
  note?: string | null;
};

export type HistoryMilestone = {
  id: number;
  date: string; // YYYY-MM-DD
  label: string;
  /** The total as recorded by hand. */
  totalCents: number;
  /** Sum of the included lines — may differ from `totalCents`. */
  computedCents: number;
  included: MilestoneLine[];
  excluded: MilestoneLine[];
  goal?: string | null;
  note?: string | null;
};

export type MilestoneInput = {
  date: string;
  label?: string;
  totalCents?: number;
  goal?: string | null;
  note?: string | null;
  included: MilestoneLine[];
  excluded?: MilestoneLine[];
};

/** "2025-06-15" -> "Jun 15, 2025", matching how the milestones read by hand. */
export function defaultLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${months[m - 1]} ${d}, ${y}`;
}

/** All milestones oldest-first, each with its lines. */
export async function getMilestones(): Promise<HistoryMilestone[]> {
  const rows = await db.query.netWorthMilestones.findMany({
    with: { lines: true },
    orderBy: [asc(netWorthMilestones.date)],
  });

  return rows.map((m) => {
    const lines = [...m.lines].sort((a, b) => a.sortOrder - b.sortOrder);
    const included = lines.filter((l) => !l.isExcluded);
    return {
      id: m.id,
      date: m.date,
      label: m.label,
      totalCents: m.totalCents,
      computedCents: included.reduce((s, l) => s + l.cents, 0),
      included: included.map((l) => ({
        id: l.id,
        label: l.label,
        cents: l.cents,
        note: l.note,
      })),
      excluded: lines
        .filter((l) => l.isExcluded)
        .map((l) => ({ id: l.id, label: l.label, cents: l.cents, note: l.note })),
      goal: m.goal,
      note: m.note,
    };
  });
}

async function replaceLines(milestoneId: number, input: MilestoneInput) {
  await db
    .delete(netWorthMilestoneLines)
    .where(eq(netWorthMilestoneLines.milestoneId, milestoneId));

  const rows = [
    ...input.included.map((l, i) => ({ ...l, isExcluded: false, sortOrder: i })),
    ...(input.excluded ?? []).map((l, i) => ({
      ...l,
      isExcluded: true,
      sortOrder: input.included.length + i,
    })),
  ]
    .filter((l) => l.label.trim())
    .map((l) => ({
      milestoneId,
      label: l.label.trim(),
      cents: Math.round(l.cents),
      note: l.note?.trim() || null,
      isExcluded: l.isExcluded,
      sortOrder: l.sortOrder,
    }));

  if (rows.length) await db.insert(netWorthMilestoneLines).values(rows);
}

/**
 * Create a milestone, or replace the one already on that date — the date is
 * unique, so re-saving the same day corrects it rather than duplicating it.
 * An omitted `totalCents` falls back to the sum of the included lines.
 */
export async function upsertMilestone(input: MilestoneInput): Promise<number> {
  const computed = input.included.reduce((s, l) => s + Math.round(l.cents), 0);
  const values = {
    date: input.date,
    label: input.label?.trim() || defaultLabel(input.date),
    totalCents: Math.round(input.totalCents ?? computed),
    goal: input.goal?.trim() || null,
    note: input.note?.trim() || null,
  };

  const existing = await db.query.netWorthMilestones.findFirst({
    where: eq(netWorthMilestones.date, input.date),
  });

  let id: number;
  if (existing) {
    await db
      .update(netWorthMilestones)
      .set(values)
      .where(eq(netWorthMilestones.id, existing.id));
    id = existing.id;
  } else {
    const [row] = await db.insert(netWorthMilestones).values(values).returning();
    id = row.id;
  }

  await replaceLines(id, input);
  return id;
}

/** Lines cascade via the FK. */
export async function deleteMilestone(id: number): Promise<void> {
  await db.delete(netWorthMilestones).where(eq(netWorthMilestones.id, id));
}
