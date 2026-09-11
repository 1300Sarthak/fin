import { db } from "@/db";
import { goals, goalAccounts, type GoalType } from "@/db/schema";
import { eq } from "drizzle-orm";

export type GoalInput = {
  name: string;
  type?: GoalType;
  targetCents?: number;
  priority?: number;
  annualCapCents?: number | null;
  linkedAccountId?: number | null;
  parentGoalId?: number | null;
  accountIds?: number[];
};

/** Keep the hierarchy one level deep and acyclic. */
async function assertValidParent(parentGoalId: number | null | undefined, selfId?: number) {
  if (parentGoalId == null) return;
  if (selfId != null && parentGoalId === selfId) {
    throw new Error("A goal cannot be its own parent");
  }
  const parent = await db
    .select({ id: goals.id, parentGoalId: goals.parentGoalId })
    .from(goals)
    .where(eq(goals.id, parentGoalId))
    .get();
  if (!parent) throw new Error("Parent goal not found");
  if (parent.parentGoalId != null) throw new Error("Sub-goals can only be one level deep");

  // A goal that already has its own children can't itself become a sub-goal.
  if (selfId != null) {
    const child = await db
      .select({ id: goals.id })
      .from(goals)
      .where(eq(goals.parentGoalId, selfId))
      .get();
    if (child) throw new Error("A goal with sub-goals can't become a sub-goal");
  }
}

async function setAccountLinks(goalId: number, accountIds: number[]) {
  await db.delete(goalAccounts).where(eq(goalAccounts.goalId, goalId));
  if (accountIds.length) {
    await db.insert(goalAccounts).values(accountIds.map((accountId) => ({ goalId, accountId })));
  }
}

export async function createGoal(input: GoalInput): Promise<number> {
  if (!input.name?.trim()) throw new Error("Name is required");
  await assertValidParent(input.parentGoalId);
  const [row] = await db
    .insert(goals)
    .values({
      name: input.name.trim(),
      type: input.type ?? "custom",
      targetCents: input.targetCents ?? 0,
      priority: input.priority ?? 0,
      annualCapCents: input.annualCapCents ?? null,
      linkedAccountId: input.linkedAccountId ?? null,
      parentGoalId: input.parentGoalId ?? null,
    })
    .returning({ id: goals.id });
  if (input.accountIds?.length) await setAccountLinks(row.id, input.accountIds);
  return row.id;
}

export async function updateGoal(id: number, input: Partial<GoalInput>): Promise<void> {
  if (input.parentGoalId !== undefined) await assertValidParent(input.parentGoalId, id);

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.type !== undefined) set.type = input.type;
  if (input.targetCents !== undefined) set.targetCents = input.targetCents;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.annualCapCents !== undefined) set.annualCapCents = input.annualCapCents;
  if (input.linkedAccountId !== undefined) set.linkedAccountId = input.linkedAccountId;
  if (input.parentGoalId !== undefined) set.parentGoalId = input.parentGoalId;
  if (Object.keys(set).length) await db.update(goals).set(set).where(eq(goals.id, id));

  if (input.accountIds !== undefined) await setAccountLinks(id, input.accountIds);
}

export async function deleteGoal(id: number): Promise<void> {
  // Reparent children to top-level rather than cascade-deleting them, then drop
  // join rows explicitly (don't rely on PRAGMA foreign_keys), then the goal.
  await db.update(goals).set({ parentGoalId: null }).where(eq(goals.parentGoalId, id));
  await db.delete(goalAccounts).where(eq(goalAccounts.goalId, id));
  await db.delete(goals).where(eq(goals.id, id));
}
