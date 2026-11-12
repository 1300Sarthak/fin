import { db } from "@/db";
import { goals, goalAccounts, accounts, type Goal, type GoalType } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getMonthlyTrend } from "@/lib/spending";
import { getConfigCents } from "@/lib/config";
import type { PlannerGoal } from "@/lib/planner-core";
import { getGoalProgress, type GoalProgress } from "@/lib/goals";
import { planWindow, type ProgressKind } from "@/lib/goals-core";
import { isoDate } from "@/lib/format";

/**
 * Load active goals + the data needed to resolve each one's current balance and
 * the parent/child hierarchy. A goal's current resolves by precedence:
 * goal_accounts rows → single linkedAccountId → type heuristic.
 */
async function loadGoalContext() {
  const gs = await db
    .select()
    .from(goals)
    .where(eq(goals.isActive, true))
    .orderBy(goals.priority);
  const accs = await db.select().from(accounts);
  const links = await db.select().from(goalAccounts);

  const accById = new Map(accs.map((a) => [a.id, a]));
  const accountIdsByGoal = new Map<number, number[]>();
  for (const l of links) {
    const list = accountIdsByGoal.get(l.goalId) ?? [];
    list.push(l.accountId);
    accountIdsByGoal.set(l.goalId, list);
  }
  const childrenOf = new Map<number, Goal[]>();
  for (const g of gs) {
    if (g.parentGoalId != null) {
      const list = childrenOf.get(g.parentGoalId) ?? [];
      list.push(g);
      childrenOf.set(g.parentGoalId, list);
    }
  }

  const sumTypes = (types: string[]) =>
    accs
      .filter((a) => types.includes(a.type) && a.isAsset)
      .reduce((s, a) => s + a.currentBalanceCents, 0);

  const today = isoDate(new Date());
  const progress = await getGoalProgress(gs, today);

  const resolveLeafCurrent = (g: Goal): number => {
    const measured = progress.get(g.id);
    if (measured) return measured.currentCents;
    const ids = accountIdsByGoal.get(g.id);
    if (ids && ids.length) {
      return ids.reduce((s, id) => s + (accById.get(id)?.currentBalanceCents ?? 0), 0);
    }
    if (g.linkedAccountId) return accById.get(g.linkedAccountId)?.currentBalanceCents ?? 0;
    if (g.type === "emergency_fund") return sumTypes(["hysa", "savings"]);
    if (g.type === "retirement") return sumTypes(["ira"]);
    if (g.type === "taxable_invest") return sumTypes(["brokerage", "crypto"]);
    return 0;
  };

  return { gs, accountIdsByGoal, childrenOf, resolveLeafCurrent, progress, today };
}

/**
 * The fundable set for the waterfall: leaf goals only (no children), whether or
 * not they have a parent. Parent goals are display rollups (see getGoalsTree)
 * and never compete for surplus, so the pure engine stays unaware of hierarchy.
 */
export async function getGoalsWithCurrent(): Promise<PlannerGoal[]> {
  const { gs, childrenOf, resolveLeafCurrent } = await loadGoalContext();
  return gs
    .filter((g) => !childrenOf.has(g.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      priority: g.priority,
      targetCents: g.targetCents,
      currentCents: resolveLeafCurrent(g),
    }));
}

export type GoalNode = {
  id: number;
  name: string;
  type: GoalType;
  priority: number;
  targetCents: number;
  currentCents: number;
  linkedAccountId: number | null;
  accountIds: number[];
  parentGoalId: number | null;
  progressKind: ProgressKind;
  taxYear: number | null;
  manualProgressCents: number | null;
  /** How a tax-year goal is measured, its deadline and notes; null for balance goals. */
  progress: GoalProgress | null;
  children: GoalNode[];
};

/**
 * Goals as a one-level tree for the CRUD/display UI. A parent's current/target
 * roll up from its children (the parent's own links are ignored to avoid double
 * counting).
 */
export async function getGoalsTree(): Promise<GoalNode[]> {
  const { gs, accountIdsByGoal, childrenOf, resolveLeafCurrent, progress } = await loadGoalContext();
  const measure = (g: Goal) => ({ progressKind: g.progressKind, taxYear: g.taxYear, manualProgressCents: g.manualProgressCents });

  const leafNode = (g: Goal): GoalNode => ({
    id: g.id,
    name: g.name,
    type: g.type,
    priority: g.priority,
    targetCents: g.targetCents,
    currentCents: resolveLeafCurrent(g),
    linkedAccountId: g.linkedAccountId,
    accountIds: accountIdsByGoal.get(g.id) ?? [],
    parentGoalId: g.parentGoalId,
    ...measure(g),
    progress: progress.get(g.id) ?? null,
    children: [],
  });

  return gs
    .filter((g) => g.parentGoalId == null)
    .map((g) => {
      const kids = childrenOf.get(g.id);
      if (!kids || kids.length === 0) return leafNode(g);
      const children = kids.map(leafNode);
      return {
        id: g.id,
        name: g.name,
        type: g.type,
        priority: g.priority,
        targetCents: children.reduce((s, c) => s + c.targetCents, 0),
        currentCents: children.reduce((s, c) => s + c.currentCents, 0),
        linkedAccountId: g.linkedAccountId,
        accountIds: accountIdsByGoal.get(g.id) ?? [],
        parentGoalId: null,
        ...measure(g),
        progress: null,
        children,
      };
    });
}

/** Estimate monthly free cash flow = avg(income − expense) over recent whole months. */
export async function getMonthlyFreeCashFlow(): Promise<{
  estimateCents: number;
  lookbackMonths: number;
}> {
  const lookback = (await getConfigCents("fcf_lookback_months")) ?? 3;
  const trend = await getMonthlyTrend(Math.max(2, lookback + 1));
  // drop the current (partial) month for a cleaner average
  const whole = trend.length > 1 ? trend.slice(0, -1) : trend;
  const avg =
    whole.reduce((s, t) => s + (t.income - t.expense), 0) / (whole.length || 1);
  return { estimateCents: Math.round(avg), lookbackMonths: whole.length };
}

export type Debt = { id: number; name: string; balanceCents: number };

/** Liabilities ordered smallest-balance-first (classic debt snowball). */
export async function getDebtSnowball(): Promise<Debt[]> {
  const accs = await db.select().from(accounts);
  return accs
    .filter((a) => !a.isAsset && a.currentBalanceCents > 0)
    .sort((a, b) => a.currentBalanceCents - b.currentBalanceCents)
    .map((a) => ({ id: a.id, name: a.name, balanceCents: a.currentBalanceCents }));
}
