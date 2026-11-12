/**
 * Goals against a real (temp) database: a balance goal reads balances exactly
 * as before, a Roth goal counts the year's deduped contributions, a manual
 * goal reads the entered figure, and writes are validated. Fixture rows are
 * dated 2024 so they stay clear of the shared fixtures.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db, schema } from "./assistant/test-db";

const { createGoal, updateGoal, deleteGoal, findGoalByName } = await import("@/lib/goals");
const { getGoalsTree, getGoalsWithCurrent } = await import("@/lib/planner");

const { accounts, transactions, goals } = schema;
const day = (d: string) => new Date(`${d}T12:00:00Z`);
const made = { accounts: [] as number[], txns: [] as number[], goals: [] as number[] };

beforeAll(async () => {
  const [savings, roth] = await db.insert(accounts).values([
    { name: "Goal test savings", type: "hysa", source: "manual", currentBalanceCents: 123_456 },
    { name: "Goal test ROTH IRA", type: "ira", source: "manual", currentBalanceCents: 2_000_000 },
  ]).returning();
  made.accounts.push(savings.id, roth.id);
  const rows = await db.insert(transactions).values([
    { accountId: roth.id, postedAt: day("2024-03-01"), amountCents: -100_000, merchantRaw: "Cash Contribution Prior Year" },
    { accountId: roth.id, postedAt: day("2024-06-01"), amountCents: -200_000, merchantRaw: "Cash Contribution Current Year" },
    { accountId: roth.id, postedAt: day("2024-06-01"), amountCents: 200_000, merchantRaw: "Current Year Contribution" },
    { accountId: roth.id, postedAt: day("2025-02-01"), amountCents: 50_000, merchantRaw: "Cash Contribution Prior Year" },
  ]).returning();
  made.txns.push(...rows.map((r) => r.id));
  made.goals.push(
    await createGoal({ name: "Goal test cushion", targetCents: 500_000, accountIds: [savings.id] }),
    await createGoal({ name: "Goal test Roth 2024", targetCents: 700_000, progressKind: "roth_ira", taxYear: 2024 }),
    await createGoal({ name: "Goal test Student loan interest 2024", targetCents: 250_000, progressKind: "manual", taxYear: 2024, manualProgressCents: 31_000 }),
  );
});

afterAll(async () => {
  await db.delete(goals).where(inArray(goals.id, made.goals));
  await db.delete(transactions).where(inArray(transactions.id, made.txns));
  await db.delete(accounts).where(inArray(accounts.id, made.accounts));
});

const node = async (name: string) => (await getGoalsTree()).find((g) => g.name === name)!;

describe("goal progress by kind", () => {
  test("balance: linked account balance, no tax-year details", async () => {
    const g = await node("Goal test cushion");
    expect(g.currentCents).toBe(123_456);
    expect(g.progress).toBeNull();
  });
  test("roth_ira: the year's contributions once each, plus a prior-year one made by April 15", async () => {
    const g = await node("Goal test Roth 2024");
    expect(g.currentCents).toBe(250_000);
    expect(g.progress?.deadline).toBe("2025-04-15");
    expect(g.progress?.window).toBe("closed");
    expect(g.progress?.notes.join(" ")).toContain("counted toward 2023");
  });
  test("manual: the entered amount; a closed year leaves the contribution plan", async () => {
    const g = await node("Goal test Student loan interest 2024");
    expect(g.currentCents).toBe(31_000);
    expect(g.progress?.studentLoan?.moreInterestCents).toBe(219_000);
    const plan = await getGoalsWithCurrent();
    expect(plan.goals.some((x) => x.name === "Goal test Roth 2024")).toBe(false);
    expect(plan.left.find((x) => x.name === "Goal test Roth 2024")?.why).toBe("contribution window closed");
    expect(plan.goals.some((x) => x.name === "Goal test cushion")).toBe(true);
  });
});

describe("goal writes", () => {
  test("a tax-year measure needs a year, and unknown fields are refused", async () => {
    await expect(createGoal({ name: "Goal test bad", progressKind: "hsa" })).rejects.toThrow("needs a tax year");
    await expect(createGoal({ name: "Goal test bad", nope: 1 } as never)).rejects.toThrow();
    await expect(updateGoal(made.goals[0], { manualProgressCents: -5 })).rejects.toThrow();
  });
  test("find by name is case-insensitive; delete removes it", async () => {
    const id = await createGoal({ name: "Goal test Temp", targetCents: 100 });
    expect((await findGoalByName("goal TEST temp"))?.id).toBe(id);
    await deleteGoal(id);
    expect(await findGoalByName("Goal test Temp")).toBeUndefined();
  });
});
