/**
 * Pure math for budget groups: which categories a group owns, what it spent,
 * and whether the month is on pace. Kept free of database imports so the rules
 * can be tested on fixtures; `budget-groups.ts` loads the rows.
 *
 * Ownership rules:
 *   - a group lists category ids; a parent id also claims all its descendants
 *   - a category claimed by an earlier group (sortOrder, then id) is not
 *     counted again by a later one, so group totals always add up
 *   - the catch-all group takes every spending category no other group claims,
 *     uncategorized spending included
 */

export type CategoryNode = { id: number; parentId: number | null; name: string; kind?: string };

/** Movement between your own accounts or into investments is never budget spending. */
const NOT_SPENDING = new Set(["transfer", "investment"]);

export type BudgetGroupDef = {
  id: number;
  name: string;
  limitCents: number;
  categoryIds: number[];
  catchAll: boolean;
  sortOrder: number;
};

/** Net spend for one category in the month (categoryId null = uncategorized). */
export type CategorySpendRow = { categoryId: number | null; name: string; spentCents: number };

export type MonthClock = { daysInMonth: number; daysElapsed: number };

/** "over-pace" is bad: spending faster than a straight-line month would. */
export type GroupStatus = "over" | "over-pace" | "on-track";

export type BudgetGroupReport = {
  id: number;
  name: string;
  limitCents: number;
  catchAll: boolean;
  sortOrder: number;
  /** Category ids this group actually counts, after expansion and de-duplication. */
  categoryIds: number[];
  /** What the user configured, before expansion. */
  configuredCategoryIds: number[];
  /** True when the catch-all also counts uncategorized spending. */
  includesUncategorized: boolean;
  spentCents: number;
  remainingCents: number;
  pct: number;
  /** Spending a straight-line month would have reached by today. */
  expectedCents: number;
  /** spent − expected: positive means over pace (spending too fast). */
  paceDeltaCents: number;
  /** Fraction of the month elapsed, 0–1: where the pace marker sits. */
  paceFraction: number;
  projectedCents: number;
  daysRemaining: number;
  /** What is left spread over the days left; null once the month is over. */
  perDayRemainingCents: number | null;
  status: GroupStatus;
  /** Per-category spend inside the group, largest first, for drill-down. */
  categories: CategorySpendRow[];
};

/** `ids` plus every descendant of them. Unknown ids are kept as given. */
export function expandCategoryIds(ids: number[], nodes: CategoryNode[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const n of nodes) {
    if (n.parentId == null) continue;
    children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  }
  const out = new Set<number>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

const byOrder = (a: BudgetGroupDef, b: BudgetGroupDef) => a.sortOrder - b.sortOrder || a.id - b.id;

/** The pace phrase the UI and CLI both print: "$X over pace" is a warning, "$X under pace" is good. */
export function paceLabel(g: { status: GroupStatus; paceDeltaCents: number }, usd: (cents: number) => string): string {
  if (g.status === "over") return "Over budget";
  return g.paceDeltaCents > 0 ? `${usd(g.paceDeltaCents)} over pace` : `${usd(-g.paceDeltaCents)} under pace`;
}

/**
 * Month-end spend at the current daily rate, rounded once. Spending, the
 * allowance and budget groups all project with this so they print one number.
 */
export const projectMonthEnd = (spentCents: number, daysElapsed: number, daysInMonth: number): number =>
  daysElapsed > 0 ? Math.round((spentCents / daysElapsed) * daysInMonth) : spentCents;

/** Straight-line pace numbers for one limit. */
export function pace(spentCents: number, limitCents: number, clock: MonthClock) {
  const { daysInMonth, daysElapsed } = clock;
  const paceFraction = daysInMonth > 0 ? Math.min(Math.max(daysElapsed / daysInMonth, 0), 1) : 1;
  const expectedCents = Math.round(limitCents * paceFraction);
  const daysRemaining = Math.max(daysInMonth - daysElapsed, 0);
  const projectedCents = projectMonthEnd(spentCents, daysElapsed, daysInMonth);
  const remainingCents = limitCents - spentCents;
  const status: GroupStatus =
    spentCents > limitCents ? "over" : spentCents > expectedCents ? "over-pace" : "on-track";
  return {
    expectedCents,
    paceDeltaCents: spentCents - expectedCents,
    paceFraction,
    projectedCents,
    daysRemaining,
    remainingCents,
    perDayRemainingCents: daysRemaining > 0 ? Math.floor(Math.max(remainingCents, 0) / daysRemaining) : null,
    status,
    pct: limitCents > 0 ? spentCents / limitCents : 0,
  };
}

export function computeBudgetGroups(
  groups: BudgetGroupDef[],
  nodes: CategoryNode[],
  spend: CategorySpendRow[],
  clock: MonthClock,
): BudgetGroupReport[] {
  const ordered = [...groups].sort(byOrder);
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const eligible = spend.filter((r) => r.categoryId == null || !NOT_SPENDING.has(kindOf.get(r.categoryId) ?? ""));
  const claimed = new Set<number>();
  const owned = new Map<number, Set<number>>();
  for (const g of ordered) {
    if (g.catchAll) continue;
    const mine = new Set([...expandCategoryIds(g.categoryIds, nodes)].filter((id) => !claimed.has(id)));
    mine.forEach((id) => claimed.add(id));
    owned.set(g.id, mine);
  }
  // Only the first catch-all takes the rest; a second one would double count.
  const catchAllId = ordered.find((g) => g.catchAll)?.id;

  return ordered.map((g) => {
    const isCatchAll = g.id === catchAllId;
    const mine = owned.get(g.id) ?? new Set<number>();
    const rows = eligible
      .filter((r) =>
        isCatchAll ? r.categoryId == null || !claimed.has(r.categoryId) : r.categoryId != null && mine.has(r.categoryId),
      )
      .sort((a, b) => b.spentCents - a.spentCents);
    const spentCents = rows.reduce((s, r) => s + r.spentCents, 0);
    const categoryIds = isCatchAll
      ? nodes.filter((n) => !claimed.has(n.id) && (n.kind ?? "expense") === "expense").map((n) => n.id)
      : [...mine];
    return {
      id: g.id,
      name: g.name,
      limitCents: g.limitCents,
      catchAll: g.catchAll,
      sortOrder: g.sortOrder,
      categoryIds,
      configuredCategoryIds: g.categoryIds,
      includesUncategorized: isCatchAll,
      spentCents,
      categories: rows,
      ...pace(spentCents, g.limitCents, clock),
    };
  });
}

/** Totals across groups, for the allowance and the summary line. */
export function totalOf(reports: BudgetGroupReport[]) {
  return reports.reduce(
    (t, r) => ({ limitCents: t.limitCents + r.limitCents, spentCents: t.spentCents + r.spentCents }),
    { limitCents: 0, spentCents: 0 },
  );
}

/** Parse the stored JSON list; anything malformed reads as no categories. */
export function parseCategoryIds(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [];
  } catch {
    return [];
  }
}
