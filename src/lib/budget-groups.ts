/**
 * Budget groups: a monthly limit over a set of categories ("Food" = Food &
 * Dining + Groceries), plus at most one catch-all for everything else. The
 * math lives in `budget-groups-core.ts`; this file loads rows and writes them.
 *
 * Spending is the spending page's own definition (`getSpendingByCategory`):
 * outflows net of refunds, pending holds included, transfers, card payments,
 * investment accounts and excluded rows left out. So a group's total always
 * reconciles with /spending and `fin spending`.
 */
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { budgetGroups, categories } from "@/db/schema";
import { getBudgetsWithActual, getSpendingByCategory, monthRange, type BudgetRow } from "@/lib/spending";
import { pacificCalendarDate } from "@/lib/calendar";
import {
  computeBudgetGroups,
  expandCategoryIds,
  parseCategoryIds,
  totalOf,
  type BudgetGroupDef,
  type BudgetGroupReport,
  type CategoryNode,
  type MonthClock,
} from "@/lib/budget-groups-core";

export * from "@/lib/budget-groups-core";

export async function getCategoryNodes(): Promise<CategoryNode[]> {
  return db
    .select({ id: categories.id, parentId: categories.parentId, name: categories.name, kind: categories.kind })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.id));
}

export async function listBudgetGroups(): Promise<BudgetGroupDef[]> {
  const rows = await db.select().from(budgetGroups).orderBy(asc(budgetGroups.sortOrder), asc(budgetGroups.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    limitCents: r.limitCents,
    categoryIds: parseCategoryIds(r.categoryIdsJson),
    catchAll: r.catchAll,
    sortOrder: r.sortOrder,
  }));
}

/** Days elapsed on the Pacific calendar, matching the allowance. */
export function monthClock(monthKey: string, today = pacificCalendarDate()): MonthClock {
  const r = monthRange(monthKey);
  const daysInMonth = r.end.getDate();
  const elapsed = today.startsWith(monthKey) ? Number(today.slice(8, 10)) : today > monthKey ? daysInMonth : 0;
  return { daysInMonth, daysElapsed: Math.min(Math.max(elapsed, 0), daysInMonth) };
}

export type BudgetGroupsReport = {
  monthKey: string;
  label: string;
  /** Inclusive YYYY-MM-DD bounds of the month, for drill-down links. */
  from: string;
  to: string;
  clock: MonthClock;
  groups: BudgetGroupReport[];
  total: ReturnType<typeof totalOf> & { remainingCents: number; pct: number };
  /** Older single-category budgets, still honoured and shown beside groups. */
  legacy: BudgetRow[];
};

export async function getBudgetGroupsReport(month?: string, accountIds?: number[]): Promise<BudgetGroupsReport> {
  const r = monthRange(month);
  const [groups, nodes, spend, legacy] = await Promise.all([
    listBudgetGroups(),
    getCategoryNodes(),
    getSpendingByCategory(r, accountIds),
    getBudgetsWithActual(r, accountIds),
  ]);
  const clock = monthClock(r.key);
  const reports = computeBudgetGroups(
    groups,
    nodes,
    spend.map((s) => ({ categoryId: s.categoryId, name: s.name, spentCents: s.spentCents })),
    clock,
  );
  const t = totalOf(reports);
  return {
    monthKey: r.key,
    label: r.label,
    from: `${r.key}-01`,
    to: `${r.key}-${String(clock.daysInMonth).padStart(2, "0")}`,
    clock,
    groups: reports,
    total: { ...t, remainingCents: t.limitCents - t.spentCents, pct: t.limitCents > 0 ? t.spentCents / t.limitCents : 0 },
    legacy,
  };
}

/* --------------------------------- writes ---------------------------------- */

export const budgetGroupInput = z
  .object({
    /** Given when editing, so a rename updates the group instead of adding one. */
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(60),
    limitCents: z.number().int().positive().max(100_000_000),
    categoryIds: z.array(z.number().int().positive()).max(200).default([]),
    catchAll: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type BudgetGroupInput = z.input<typeof budgetGroupInput>;

/** Resolve names (case-insensitive) to ids; an unknown name is an error, never skipped. */
export async function categoryIdsByName(names: string[]): Promise<number[]> {
  const nodes = await getCategoryNodes();
  const byName = new Map(nodes.map((n) => [n.name.toLowerCase(), n.id]));
  const missing = names.filter((n) => !byName.has(n.trim().toLowerCase()));
  if (missing.length) {
    throw new Error(`unknown categor${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}.`);
  }
  return names.map((n) => byName.get(n.trim().toLowerCase())!);
}

/**
 * Create or replace a group (by id when given, else by name). Refuses a second catch-all, a catch-all
 * with categories, a group with none, a transfer/investment category, and a
 * category another group already counts — overlap would make totals lie.
 */
export async function saveBudgetGroup(raw: BudgetGroupInput): Promise<BudgetGroupDef> {
  const input = budgetGroupInput.parse(raw);
  const [groups, nodes] = await Promise.all([listBudgetGroups(), getCategoryNodes()]);
  const sameName = groups.find((g) => g.name.toLowerCase() === input.name.toLowerCase());
  const existing = input.id ? groups.find((g) => g.id === input.id) : sameName;
  if (input.id && !existing) throw new Error(`no budget group #${input.id}`);
  if (sameName && existing && sameName.id !== existing.id) throw new Error(`a group named "${sameName.name}" already exists`);
  const others = groups.filter((g) => g.id !== existing?.id);
  const ids = [...new Set(input.categoryIds)];

  if (input.catchAll) {
    if (ids.length) throw new Error("a catch-all group takes every unclaimed category; don't list categories for it");
    const other = others.find((g) => g.catchAll);
    if (other) throw new Error(`"${other.name}" is already the catch-all group`);
  } else {
    if (!ids.length) throw new Error("choose at least one category, or make it the catch-all");
    const known = new Map(nodes.map((n) => [n.id, n]));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`unknown category id ${unknown.join(", ")}`);
    const notSpend = ids.map((id) => known.get(id)!).filter((n) => n.kind !== "expense");
    if (notSpend.length) throw new Error(`${notSpend.map((n) => n.name).join(", ")} is not spending and can't be budgeted`);
    const mine = expandCategoryIds(ids, nodes);
    for (const g of others) {
      if (g.catchAll) continue;
      const clash = [...expandCategoryIds(g.categoryIds, nodes)].filter((id) => mine.has(id));
      if (clash.length) {
        throw new Error(`${clash.map((id) => known.get(id)?.name ?? id).join(", ")} already belong to "${g.name}"`);
      }
    }
  }

  const values = {
    name: input.name,
    limitCents: input.limitCents,
    categoryIdsJson: JSON.stringify(ids),
    catchAll: input.catchAll,
    sortOrder: input.sortOrder ?? existing?.sortOrder ?? (input.catchAll ? 1_000 : others.filter((g) => !g.catchAll).length),
  };
  const [row] = existing
    ? await db.update(budgetGroups).set(values).where(eq(budgetGroups.id, existing.id)).returning()
    : await db.insert(budgetGroups).values(values).returning();
  return { id: row.id, name: row.name, limitCents: row.limitCents, categoryIds: ids, catchAll: row.catchAll, sortOrder: row.sortOrder };
}

/** Delete by id or (case-insensitive) name. Returns the removed name. */
export async function removeBudgetGroup(key: number | string): Promise<string> {
  const groups = await listBudgetGroups();
  const g = groups.find((x) => (typeof key === "number" ? x.id === key : x.name.toLowerCase() === key.trim().toLowerCase()));
  if (!g) throw new Error(`no budget group ${typeof key === "number" ? `#${key}` : `"${key}"`}`);
  await db.delete(budgetGroups).where(eq(budgetGroups.id, g.id));
  return g.name;
}
