/**
 * Pure snowball/waterfall allocation engine. No DB, no Date.now — safe to import
 * from client components (the what-if slider) and unit tests.
 *
 * Each month, the available surplus is poured into goals in priority order:
 * a goal fills to its target, then the overflow cascades to the next goal.
 * A goal with target 0 is an open-ended "overflow" bucket (e.g. ongoing
 * investing) that absorbs whatever remains and never "completes".
 */

export type PlannerGoal = {
  id: number;
  name: string;
  type: string;
  priority: number;
  targetCents: number; // 0 = open-ended overflow bucket
  currentCents: number;
};

export type GoalProjection = PlannerGoal & {
  monthlyAllocationCents: number; // funded toward this goal in the first month
  monthsToComplete: number | null; // null = already done OR open-ended
  isComplete: boolean;
  isOpenEnded: boolean;
  progress: number; // 0..1 (1 for open-ended)
};

export type WaterfallResult = {
  goals: GoalProjection[];
  monthlySurplusCents: number;
  monthsToAllFunded: number; // months until every targeted goal is funded (0 if none pending)
};

const MAX_MONTHS = 1200; // 100-year safety cap

export function simulateWaterfall(
  goals: PlannerGoal[],
  monthlySurplusCents: number,
): WaterfallResult {
  const ordered = [...goals].sort((a, b) => a.priority - b.priority);
  const bal = ordered.map((g) => g.currentCents);
  const months = ordered.map<number | null>(() => null);
  const firstAlloc = ordered.map(() => 0);
  const surplus = Math.max(0, Math.round(monthlySurplusCents));

  const targeted = (i: number) => ordered[i].targetCents > 0;
  const isFull = (i: number) => targeted(i) && bal[i] >= ordered[i].targetCents;

  // record goals already complete at month 0
  for (let i = 0; i < ordered.length; i++) {
    if (isFull(i)) months[i] = 0;
  }

  if (surplus > 0) {
    for (let m = 1; m <= MAX_MONTHS; m++) {
      let remaining = surplus;
      for (let i = 0; i < ordered.length && remaining > 0; i++) {
        if (isFull(i)) continue;
        const need = targeted(i)
          ? ordered[i].targetCents - bal[i]
          : Infinity;
        const alloc = Math.min(remaining, need);
        bal[i] += alloc;
        remaining -= alloc;
        if (m === 1) firstAlloc[i] = alloc;
        if (targeted(i) && bal[i] >= ordered[i].targetCents && months[i] == null) {
          months[i] = m;
        }
      }
      if (ordered.every((_, i) => !targeted(i) || isFull(i))) break;
    }
  }

  const projections: GoalProjection[] = ordered.map((g, i) => {
    const isOpenEnded = g.targetCents <= 0;
    // "complete" means already funded at the *current* balance, not after the sim.
    const isComplete = !isOpenEnded && g.currentCents >= g.targetCents;
    return {
      ...g,
      monthlyAllocationCents: firstAlloc[i],
      monthsToComplete: isOpenEnded || months[i] === 0 ? null : months[i],
      isComplete,
      isOpenEnded,
      progress: isOpenEnded
        ? 1
        : Math.min(1, g.targetCents > 0 ? g.currentCents / g.targetCents : 1),
    };
  });

  const targetedMonths = projections
    .filter((p) => !p.isOpenEnded)
    .map((p) => p.monthsToComplete)
    .filter((x): x is number => x != null);
  const monthsToAllFunded = targetedMonths.length
    ? Math.max(...targetedMonths)
    : 0;

  return { goals: projections, monthlySurplusCents: surplus, monthsToAllFunded };
}
