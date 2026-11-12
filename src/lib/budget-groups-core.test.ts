import { describe, expect, test } from "bun:test";
import {
  computeBudgetGroups,
  expandCategoryIds,
  pace,
  paceLabel,
  parseCategoryIds,
  projectMonthEnd,
  totalOf,
  type BudgetGroupDef,
  type CategoryNode,
} from "./budget-groups-core";

const nodes: CategoryNode[] = [
  { id: 9, parentId: null, name: "Groceries", kind: "expense" },
  { id: 10, parentId: null, name: "Food & Dining", kind: "expense" },
  { id: 11, parentId: 10, name: "Restaurants", kind: "expense" },
  { id: 12, parentId: 10, name: "Coffee Shops", kind: "expense" },
  { id: 13, parentId: 10, name: "Fast Food", kind: "expense" },
  { id: 14, parentId: null, name: "Transportation", kind: "expense" },
  { id: 16, parentId: 14, name: "Rideshare", kind: "expense" },
  { id: 43, parentId: null, name: "Transfers", kind: "transfer" },
  { id: 44, parentId: 43, name: "Credit Card Payment", kind: "transfer" },
  { id: 47, parentId: null, name: "Brokerage", kind: "investment" },
];

const group = (p: Partial<BudgetGroupDef> & { id: number; name: string }): BudgetGroupDef => ({
  limitCents: 50_000,
  categoryIds: [],
  catchAll: false,
  sortOrder: p.id,
  ...p,
});

const food = group({ id: 1, name: "Food", categoryIds: [10, 9] });
const rest = group({ id: 2, name: "Everything else", catchAll: true });
const clock = { daysInMonth: 30, daysElapsed: 10 };

describe("expandCategoryIds", () => {
  test("a parent includes its children", () => {
    expect([...expandCategoryIds([10], nodes)].sort()).toEqual([10, 11, 12, 13]);
  });
  test("a child alone does not pull in its parent", () => {
    expect([...expandCategoryIds([11], nodes)]).toEqual([11]);
  });
});

describe("computeBudgetGroups", () => {
  const spend = [
    { categoryId: 11, name: "Restaurants", spentCents: 4_000 },
    { categoryId: 12, name: "Coffee Shops", spentCents: 1_000 },
    { categoryId: 9, name: "Groceries", spentCents: 6_000 },
    { categoryId: 16, name: "Rideshare", spentCents: 2_500 },
    { categoryId: null, name: "Uncategorized", spentCents: 500 },
    { categoryId: 44, name: "Credit Card Payment", spentCents: 90_000 },
    { categoryId: 47, name: "Brokerage", spentCents: 20_000 },
  ];
  const [f, r] = computeBudgetGroups([rest, food], nodes, spend, clock);

  test("ordered by sortOrder, parent counts its children", () => {
    expect(f.name).toBe("Food");
    expect(f.spentCents).toBe(11_000);
    expect(f.categories.map((c) => c.name)).toEqual(["Groceries", "Restaurants", "Coffee Shops"]);
  });

  test("catch-all excludes claimed categories and keeps uncategorized", () => {
    expect(r.spentCents).toBe(3_000);
    expect(r.categories.map((c) => c.categoryId)).toEqual([16, null]);
    expect(r.categoryIds).not.toContain(11);
    expect(r.categoryIds).toContain(14);
  });

  test("transfers, card payments and investments never count", () => {
    expect(r.categoryIds).not.toContain(44);
    expect(r.categoryIds).not.toContain(47);
    const t = totalOf([f, r]);
    expect(t.spentCents).toBe(14_000);
    expect(t.limitCents).toBe(100_000);
  });

  test("a category claimed by two groups counts once, for the first", () => {
    const coffee = group({ id: 3, name: "Coffee", categoryIds: [12], sortOrder: 5 });
    const [a, b] = computeBudgetGroups([food, coffee], nodes, spend, clock);
    expect(a.spentCents + b.spentCents).toBe(11_000);
    expect(b.spentCents).toBe(0);
  });

  test("a group listing a transfer category still ignores it", () => {
    const odd = group({ id: 4, name: "Odd", categoryIds: [43] });
    const [o] = computeBudgetGroups([odd], nodes, spend, clock);
    expect(o.spentCents).toBe(0);
  });
});

describe("pace", () => {
  test("on track when under the straight line", () => {
    const p = pace(10_000, 60_000, { daysInMonth: 30, daysElapsed: 10 });
    expect(p.expectedCents).toBe(20_000);
    expect(p.paceDeltaCents).toBe(-10_000);
    expect(p.status).toBe("on-track");
    expect(p.projectedCents).toBe(30_000);
    expect(p.daysRemaining).toBe(20);
    expect(p.perDayRemainingCents).toBe(2_500);
  });
  test("over pace before the limit, over budget after it", () => {
    expect(pace(30_000, 60_000, clock).status).toBe("over-pace");
    expect(pace(70_000, 60_000, clock).status).toBe("over");
    expect(pace(70_000, 60_000, clock).perDayRemainingCents).toBe(0);
  });
  test("a finished month has no per-day figure", () => {
    const p = pace(50_000, 60_000, { daysInMonth: 31, daysElapsed: 31 });
    expect(p.perDayRemainingCents).toBeNull();
    expect(p.paceFraction).toBe(1);
    expect(p.projectedCents).toBe(50_000);
  });
  test("a month not started projects what is already spent", () => {
    expect(pace(0, 60_000, { daysInMonth: 30, daysElapsed: 0 }).projectedCents).toBe(0);
  });
});

test("parseCategoryIds tolerates junk", () => {
  expect(parseCategoryIds("[9, 10, \"x\", -1, 2.5]")).toEqual([9, 10]);
  expect(parseCategoryIds("nope")).toEqual([]);
});

test("projectMonthEnd rounds once, so /spending and `fin allowance` agree", () => {
  // Rounding the daily rate first gave $1,948.80; the exact projection is $1,948.73.
  expect(projectMonthEnd(77_949, 12, 30)).toBe(194_873);
  expect(pace(77_949, 100_000, { daysInMonth: 30, daysElapsed: 12 }).projectedCents).toBe(194_873);
  expect(projectMonthEnd(5_000, 0, 30)).toBe(5_000);
});

describe("paceLabel", () => {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  test("spending faster than pace reads as over pace, never ahead", () => {
    expect(paceLabel({ status: "over-pace", paceDeltaCents: 14_767 }, usd)).toBe("$147.67 over pace");
    expect(paceLabel({ status: "on-track", paceDeltaCents: -2_500 }, usd)).toBe("$25.00 under pace");
    expect(paceLabel({ status: "over", paceDeltaCents: 50_000 }, usd)).toBe("Over budget");
  });
});
