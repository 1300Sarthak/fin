/**
 * Pure snowball/waterfall allocation engine. No DB, no Date.now — safe to import
 * from client components (the what-if slider) and unit tests.
 *
 * Each month, the available surplus is poured into targeted goals, the
 * earliest deadline first (goals with no deadline after dated ones), stored
 * priority breaking ties; a goal that has not opened yet takes nothing: a goal
 * fills to its target, then the overflow cascades to the next. Only what is
 * left after every targeted goal open that month is full goes to the
 * open-ended "overflow" buckets (target 0, e.g. ongoing investing), whatever
 * their stored priority; they never "complete".
 */

export type PlannerGoal = {
  id: number;
  name: string;
  type: string;
  priority: number;
  targetCents: number; // 0 = open-ended overflow bucket
  currentCents: number;
  /** Tax-year goals: first month (1 = this month) money can go in, and the last. Unset = always open. */
  opensInMonths?: number;
  closesAfterMonths?: number;
};

export type GoalProjection = PlannerGoal & {
  monthlyAllocationCents: number; // funded toward this goal in the first month
  monthsToComplete: number | null; // null = already done OR open-ended
  isComplete: boolean;
  isOpenEnded: boolean;
  missesDeadline: boolean; // a tax-year goal the surplus cannot fill before its window closes
  progress: number; // 0..1 (1 for open-ended)
};

export type WaterfallResult = {
  goals: GoalProjection[];
  monthlySurplusCents: number;
  /** Months until every targeted goal is funded; 0 when none is pending or when any will not be funded (see the counts). */
  monthsToAllFunded: number;
  /** Targeted goals not funded today, and how many of them close before the surplus fills them. */
  pendingTargets: number;
  missedDeadlines: number;
  /** Months until the last goal that does get funded is funded (0 if none). */
  monthsToLastFunded: number;
};

const MAX_MONTHS = 1200; // 100-year safety cap

export function simulateWaterfall(
  goals: PlannerGoal[],
  monthlySurplusCents: number,
): WaterfallResult {
  // Targeted goals first, earliest deadline first (undated after dated), stored priority as the tiebreak; open-ended buckets last.
  const deadline = (g: PlannerGoal) => g.closesAfterMonths ?? Infinity;
  const open = (g: PlannerGoal) => (g.targetCents > 0 ? 0 : 1);
  const ordered = [...goals].sort((a, b) => open(a) - open(b) || deadline(a) - deadline(b) || a.priority - b.priority);
  const bal = ordered.map((g) => g.currentCents);
  const months = ordered.map<number | null>(() => null);
  const firstAlloc = ordered.map(() => 0);
  const surplus = Math.max(0, Math.round(monthlySurplusCents));

  const targeted = (i: number) => ordered[i].targetCents > 0;
  const isFull = (i: number) => targeted(i) && bal[i] >= ordered[i].targetCents;
  const closed = (i: number, m: number) => ordered[i].closesAfterMonths != null && m > ordered[i].closesAfterMonths!;
  const accepts = (i: number, m: number) => m >= (ordered[i].opensInMonths ?? 1) && !closed(i, m);

  // record goals already complete at month 0
  for (let i = 0; i < ordered.length; i++) {
    if (isFull(i)) months[i] = 0;
  }

  if (surplus > 0) {
    for (let m = 1; m <= MAX_MONTHS; m++) {
      let remaining = surplus;
      for (let i = 0; i < ordered.length && remaining > 0; i++) {
        if (isFull(i) || !accepts(i, m)) continue;
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
      if (ordered.every((_, i) => !targeted(i) || isFull(i) || closed(i, m))) break;
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
      missesDeadline: !isOpenEnded && !isComplete && g.closesAfterMonths != null && months[i] == null && surplus > 0,
      progress: isOpenEnded
        ? 1
        : Math.min(1, g.targetCents > 0 ? g.currentCents / g.targetCents : 1),
    };
  });

  const pending = projections.filter((p) => !p.isOpenEnded && !p.isComplete);
  const funded = pending.map((p) => p.monthsToComplete).filter((x): x is number => x != null);
  const monthsToLastFunded = funded.length ? Math.max(...funded) : 0;
  const allFunded = funded.length === pending.length;

  return {
    goals: projections,
    monthlySurplusCents: surplus,
    monthsToAllFunded: allFunded ? monthsToLastFunded : 0,
    pendingTargets: pending.length,
    missedDeadlines: pending.filter((p) => p.missesDeadline).length,
    monthsToLastFunded,
  };
}
