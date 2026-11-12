import { describe, expect, test } from "bun:test";
import { aggregateIncome, combine, daysBetween, earnedCents, entryBucket, incomeItems, monthEnd, previousRange, rangeDay, summarizeSource, type Basis, type Deposit, type Entry, type GroupBy, type OtherDeposit, type Source } from "./income";

const src = (o: Partial<Source>): Source => ({ id: 1, name: "Northwind", taxTreatment: "se", matchPattern: "Brightpath", hourlyRateCents: 2500, note: null, archived: false, createdAt: new Date(), ...o });
let nextId = 1;
const entry = (o: Partial<Entry>): Entry => ({ id: nextId++, sourceId: 1, workMonth: null, workDate: null, hours: null, rateCents: null, amountCents: 0, taxable: null, paidOn: null, txnId: null, note: null, createdAt: new Date(), ...o });
const dep = (id: number, date: string, amountCents: number, description = "Brightpath Learni"): Deposit => ({ id, date, amountCents, account: "BofA", description });
const linkedOf = (entries: Entry[]) => new Set(entries.flatMap((e) => (e.txnId ? [e.txnId] : [])));

describe("income math", () => {
  test("hours x rate rounds to the cent", () => {
    expect(earnedCents(12.5, 3000)).toBe(37500);
    expect(earnedCents(14, 2200)).toBe(30800);
    expect(earnedCents(1 / 3, 100)).toBe(33);
  });

  test("month end and days-to-pay", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
    expect(daysBetween(monthEnd("2026-03"), "2026-04-07")).toBe(7);
  });

  test("taxable override beats the source treatment", () => {
    expect(entryBucket({ taxTreatment: "se" }, { taxable: false })).toBe("nontaxable");
    expect(entryBucket({ taxTreatment: "se" }, { taxable: null })).toBe("se");
    expect(entryBucket({ taxTreatment: "w2" }, { taxable: null })).toBe("w2");
    expect(entryBucket({ taxTreatment: "nontaxable" }, { taxable: null })).toBe("nontaxable");
  });
});

describe("summarizeSource", () => {
  test("cash basis: December work paid in January counts next year", () => {
    const entries = [
      entry({ workMonth: "2025-12", hours: 10, amountCents: 25000, paidOn: "2026-01-06", txnId: 1 }),
      entry({ workMonth: "2026-12", hours: 4, amountCents: 10000, paidOn: "2027-01-05", txnId: 2 }),
    ];
    const s = summarizeSource(src({}), entries, [], linkedOf(entries), 2026, "2027-02-01");
    expect(s.totalCents).toBe(25000);
    expect(s.hours).toBe(10);
    expect(s.effectiveRateCents).toBe(2500);
    expect(s.entries.map((e) => e.workMonth)).toEqual(["2025-12"]);
  });

  test("nontaxable entries are split out and excluded from self-employment", () => {
    const gig = src({ name: "Studio", matchPattern: null, hourlyRateCents: null });
    const entries = [entry({ workMonth: "2026-09", amountCents: 40000, taxable: false, paidOn: "2026-10-13" }), entry({ workMonth: "2026-10", amountCents: 120000, paidOn: "2026-11-09" })];
    const s = summarizeSource(gig, entries, [], linkedOf(entries), 2026, "2026-11-11");
    expect(s.taxableCents).toBe(120000);
    expect(s.nontaxableCents).toBe(40000);
    const all = combine(2026, [s]);
    expect(all.totals).toMatchObject({ se: 120000, nontaxable: 40000, w2: 0, total: 160000 });
    expect(all.byMonth[9].Studio).toBe(40000);
    expect(all.byMonth[10].Studio).toBe(120000);
  });

  test("unmatched: pattern deposits no entry links to, this year only", () => {
    const entries = [entry({ workMonth: "2026-03", hours: 14, amountCents: 30800, paidOn: "2026-04-07", txnId: 41 })];
    const deposits = [dep(41, "2026-04-07", 30800), dep(99, "2026-08-04", 30000), dep(5, "2025-12-04", 1000), dep(7, "2026-08-01", 5000, "Acme")];
    const s = summarizeSource(src({}), entries, deposits, linkedOf(entries), 2026, "2026-11-11");
    expect(s.unmatched.map((d) => d.id)).toEqual([99]);
    expect(s.totalCents).toBe(30800); // the unmatched deposit is flagged, not counted
  });

  test("unpaid work is owed, expected after the source's typical lag", () => {
    const entries = [
      entry({ workMonth: "2026-09", hours: 40, amountCents: 100000, paidOn: "2026-10-06", txnId: 1 }),
      entry({ workMonth: "2026-10", hours: 44, amountCents: 110000, paidOn: "2026-11-06", txnId: 2 }),
      entry({ workMonth: "2026-11", hours: 10, amountCents: 25000 }),
    ];
    const s = summarizeSource(src({}), entries, [], linkedOf(entries), 2026, "2026-12-20");
    expect(s.typicalLagDays).toBe(6);
    expect(s.owed).toEqual([{ entryId: entries[2].id, workMonth: "2026-11", amountCents: 25000, expectedOn: "2026-12-06", overdue: true }]);
    expect(s.owedCents).toBe(25000);
    expect(s.unloggedMonths).toEqual([]);
  });

  test("hourly gaps: closed months with nothing logged", () => {
    const entries = [entry({ workMonth: "2026-06", hours: 1, amountCents: 2500, paidOn: "2026-07-03" }), entry({ workMonth: "2026-08", hours: 1, amountCents: 2500, paidOn: "2026-09-04" })];
    const s = summarizeSource(src({}), entries, [], linkedOf(entries), 2026, "2026-11-11");
    expect(s.unloggedMonths).toEqual(["2026-07", "2026-09", "2026-10"]);
  });

  test("W-2 income is the matched deposits, grouped by month", () => {
    const shop = src({ id: 2, name: "Acme", taxTreatment: "w2", matchPattern: "acme", hourlyRateCents: null });
    const deposits = [dep(1, "2026-06-11", 312500, "Acme"), dep(2, "2026-06-26", 104150, "ACME PAYROLL"), dep(3, "2026-07-13", 104150, "Acme"), dep(4, "2026-07-14", 999, "Brightpath")];
    const s = summarizeSource(shop, [], deposits, new Set(), 2026, "2026-11-11");
    expect(s.depositMonths).toEqual([{ month: "2026-06", cents: 416650, txnIds: [1, 2] }, { month: "2026-07", cents: 104150, txnIds: [3] }]);
    expect(s.unmatched).toEqual([]);
    const all = combine(2026, [s]);
    expect(all.totals.w2).toBe(520800);
    expect(all.totals.se).toBe(0);
  });
});

describe("income range", () => {
  const northwind = src({});
  const shop = src({ id: 2, name: "Acme", taxTreatment: "w2", matchPattern: "acme", hourlyRateCents: null });
  const entries = [
    entry({ workMonth: "2025-12", hours: 10, amountCents: 25000, paidOn: "2026-01-06", txnId: 10 }),
    entry({ workMonth: "2026-03", hours: 20, amountCents: 50000, paidOn: "2026-04-07", txnId: 11 }),
    entry({ workMonth: "2026-06", hours: 4, amountCents: 10000 }),
  ];
  const deposits = [dep(10, "2026-01-06", 25000), dep(11, "2026-04-07", 50000), dep(20, "2026-03-31", 100000, "Acme"), dep(21, "2026-07-01", 200000, "ACME")];
  const other: OtherDeposit[] = [{ ...dep(30, "2026-05-08", 700, "Interest Income"), category: "Interest" }, { ...dep(31, "2025-11-02", 300, "Cashback"), category: "Income" }];
  const run = (basis: Basis, groupBy: GroupBy, from: string | undefined, to: string, srcs = [northwind, shop], withOther = true) =>
    aggregateIncome(incomeItems(srcs, entries, deposits, withOther ? other : [], basis), srcs, { from: from && rangeDay(from, "start"), to: rangeDay(to, "end"), groupBy, basis, includeOther: withOther, unmatched: new Map(), other: withOther ? other : [] });

  test("range days: months expand to their edges, impossible days are rejected", () => {
    expect(rangeDay("2026-02", "start")).toBe("2026-02-01");
    expect(rangeDay("2026-02", "end")).toBe("2026-02-28");
    expect(rangeDay("2026-03-31", "end")).toBe("2026-03-31");
    expect(() => rangeDay("2026-02-30", "start")).toThrow();
    expect(() => rangeDay("26-01", "start")).toThrow();
  });

  test("range edges are inclusive on both days", () => {
    const r = run("paid", "month", "2026-03-31", "2026-04-07");
    expect(r.totals).toMatchObject({ w2: 100000, se: 50000, total: 150000 });
    expect(r.periods.map((p) => [p.key, p.start, p.end])).toEqual([["2026-03", "2026-03-31", "2026-03-31"], ["2026-04", "2026-04-01", "2026-04-07"]]);
    expect(run("paid", "month", "2026-04-01", "2026-04-06").totals.total).toBe(0);
  });

  test("grouping: quarter, year and Monday weeks", () => {
    const q = run("paid", "quarter", "2026-01-01", "2026-12-31");
    expect(q.periods.map((p) => [p.key, p.total])).toEqual([["2026-Q1", 125700 - 700], ["2026-Q2", 50700], ["2026-Q3", 200000], ["2026-Q4", 0]]);
    expect(q.sources.find((s) => s.name === "Acme")!.series).toEqual([100000, 0, 200000, 0]);
    const y = run("paid", "year", undefined, "2026-12-31");
    expect(y.from).toBe("2025-11-02");
    expect(y.periods.map((p) => [p.key, p.total])).toEqual([["2025", 300], ["2026", 375700]]);
    const w = run("paid", "week", "2026-04-01", "2026-04-14");
    expect(w.periods.map((p) => [p.key, p.start, p.end])).toEqual([["2026-03-30", "2026-04-01", "2026-04-05"], ["2026-04-06", "2026-04-06", "2026-04-12"], ["2026-04-13", "2026-04-13", "2026-04-14"]]);
    expect(w.periods[1].bySource.Northwind).toBe(50000);
  });

  test("basis: work dates by work month and keeps unpaid work; paid drops it", () => {
    const paid = run("paid", "month", "2025-12", "2026-06", [northwind], false);
    expect(paid.periods.find((p) => p.key === "2025-12")!.total).toBe(0);
    expect(paid.periods.find((p) => p.key === "2026-01")!.total).toBe(25000);
    expect(paid.sources[0]).toMatchObject({ totalCents: 75000, unpaidCents: 0, hours: 30, effectiveRateCents: 2500 });
    const work = run("work", "month", "2025-12", "2026-06", [northwind], false);
    expect(work.periods.find((p) => p.key === "2025-12")!.total).toBe(25000);
    expect(work.periods.find((p) => p.key === "2026-03")!.total).toBe(50000);
    expect(work.sources[0]).toMatchObject({ totalCents: 85000, unpaidCents: 10000, hours: 34 });
  });

  test("previous period: whole months shift by months, day ranges by days", () => {
    expect(previousRange("2026-01-01", "2026-11-30")).toEqual({ from: "2025-02-01", to: "2025-12-31" });
    expect(previousRange("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("2026-04-01", "2026-04-07")).toEqual({ from: "2026-03-25", to: "2026-03-31" });
    const r = run("paid", "quarter", "2026-04", "2026-06");
    expect(r.previous).toMatchObject({ from: "2026-01-01", to: "2026-03-31", deltaCents: 50700 - 125000 });
    expect(r.previous.totals).toMatchObject({ w2: 100000, se: 25000, other: 0, total: 125000 });
    expect(run("paid", "month", "2025-11", "2025-11").previous.deltaPct).toBeNull();
  });

  test("other income is its own bucket, outside the tax-treatment totals", () => {
    const r = run("paid", "year", "2026-01", "2026-12");
    expect(r.totals).toMatchObject({ w2: 300000, se: 75000, nontaxable: 0, other: 700, total: 375700 });
    expect(r.other.byCategory).toEqual([{ category: "Interest", totalCents: 700, count: 1 }]);
    expect(r.periods[0].bySource.Other).toBe(700);
  });
});

import { summarizeWindow } from "./income";

describe("summarizeWindow", () => {
  const src = { id: 1, name: "Northwind", taxTreatment: "se", matchPattern: "Brightpath", hourlyRateCents: 2500, archived: false, note: null, createdAt: new Date() } as unknown as Parameters<typeof summarizeWindow>[0];
  const e = (id: number, workMonth: string, paidOn: string | null, amountCents: number) => ({ id, sourceId: 1, workMonth, workDate: null, hours: 10, rateCents: 2500, amountCents, taxable: null, paidOn, txnId: null, note: null, createdAt: new Date() }) as unknown as Parameters<typeof summarizeWindow>[1][number];
  test("counts only pay inside the window; unpaid work overlapping it is owed; unlogged months stop at the window end", () => {
    const entries = [e(1, "2026-03", "2026-04-07", 30_000), e(2, "2026-04", "2026-05-06", 50_000), e(3, "2026-06", null, 30_000)];
    const s = summarizeWindow(src, entries, [], new Set(), "2026-05-01", "2026-06-30", "2026-11-12");
    expect(s.totalCents).toBe(50_000);
    expect(s.owed.map((o) => o.entryId)).toEqual([3]);
    expect(s.unloggedMonths).toEqual(["2026-05"]);
    expect(s.typicalLagDays).toBe(7); // lifetime, not windowed: median of 7 and 6 rounds to 7
  });
});

import { isRefundLike } from "./income";

describe("refunds are not income", () => {
  const dep = (id: number, date: string, amountCents: number, category: string, description = "x") => ({ id, date, amountCents, account: "a", description, category });
  test("tax refunds and reimbursements are recognised by category or description", () => {
    expect(isRefundLike(dep(52, "2026-04-15", 150_000, "Taxes", "Federal Tax Refund"))).toBe(true);
    expect(isRefundLike(dep(1, "2026-08-03", 39_999, "Refunds", "Best Buy"))).toBe(true);
    expect(isRefundLike(dep(2, "2026-05-01", 9_000, "Uncategorized", "Expense reimbursement"))).toBe(true);
    expect(isRefundLike(dep(312, "2026-07-27", 50_000, "Gifts & Donations"))).toBe(false);
    expect(isRefundLike(dep(3, "2026-06-30", 1_200, "Interest"))).toBe(false);
  });
  test("aggregateIncome keeps refunds out of totals and reports them separately", () => {
    const refunds = [dep(52, "2026-04-15", 150_000, "Taxes", "Federal Tax Refund")];
    const r = aggregateIncome([], [], { from: "2026-01-01", to: "2026-11-30", groupBy: "month", basis: "paid", includeOther: true, unmatched: new Map(), other: [], refunds });
    expect(r.totals.total).toBe(0);
    expect(r.refunds).toMatchObject({ totalCents: 150_000, byCategory: [{ category: "Taxes", totalCents: 150_000, count: 1 }] });
  });
});
