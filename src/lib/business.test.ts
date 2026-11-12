import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "@/db";
import { accounts, categories, incomeEntries, incomeSources, transactions } from "@/db/schema";
import { businessYear, w2ForSep, createExpense, deleteExpense, seIncome, updateExpense } from "./business";

// A year no other test file uses: every test file shares one throwaway DB.
const Y = 2031;
let electronicsTxn = 0, linkedTxn = 0, refundedTxn = 0, openAiTxn = 0;

beforeAll(async () => {
  const [acct] = await db.insert(accounts).values({ name: "Biz test card", type: "credit", isAsset: false }).returning();
  const [elec] = await db.insert(categories).values({ name: "Electronics" }).returning();
  const [soft] = await db.insert(categories).values({ name: "Software" }).returning();
  const [food] = await db.insert(categories).values({ name: "Restaurants" }).returning();
  const t = (day: string, amountCents: number, merchantRaw: string, categoryId: number, extra = {}) =>
    db.insert(transactions).values({ accountId: acct.id, postedAt: new Date(`${day}T12:00:00Z`), amountCents, merchantRaw, categoryId, ...extra }).returning().then((r) => r[0].id);
  electronicsTxn = await t(`${Y}-09-03`, -18_499, "Amazon", elec.id);
  linkedTxn = await t(`${Y}-11-03`, -24_999, "Best Buy", elec.id);
  refundedTxn = await t(`${Y}-10-20`, -1_999, "Amazon", elec.id);
  await t(`${Y}-10-31`, 1_999, "Refund Amazon", elec.id, { isRefund: true, refundsTxnId: refundedTxn });
  openAiTxn = await t(`${Y}-05-26`, -2_000, "OpenAI", soft.id);
  await t(`${Y}-05-27`, -1_500, "Taco Bell", food.id);
  await t(`${Y - 1}-12-30`, -9_999, "Old Electronics", elec.id);

  const [northwind] = await db.insert(incomeSources).values({ name: "Biz test Northwind", taxTreatment: "se" }).returning();
  const [gig] = await db.insert(incomeSources).values({ name: "Biz test Studio", taxTreatment: "se" }).returning();
  const [shop] = await db.insert(incomeSources).values({ name: "Biz test Acme", taxTreatment: "w2" }).returning();
  await db.insert(incomeEntries).values([
    { sourceId: northwind.id, amountCents: 420_000, paidOn: `${Y}-10-01` },
    { sourceId: gig.id, amountCents: 120_000, paidOn: `${Y}-08-01` },
    { sourceId: gig.id, amountCents: 40_000, paidOn: `${Y}-08-15`, taxable: false },
    { sourceId: northwind.id, amountCents: 99_900, paidOn: `${Y + 1}-01-05` },
    { sourceId: shop.id, amountCents: 9_000_000, paidOn: `${Y}-06-01` },
  ]);
});

describe("business expenses", () => {
  test("SE income counts taxable SE entries paid in the year only", async () => {
    const inc = await seIncome(Y);
    expect(inc.grossCents).toBe(540_000);
    expect(inc.nontaxableCents).toBe(40_000);
    expect(inc.sources.map((s) => s.name).sort()).toEqual(["Biz test Northwind", "Biz test Studio"]);
  });

  test("CRUD, summary, flags, and suggestions", async () => {
    const id = await createExpense({ taxYear: Y, item: "Sony headphones", amountCents: 24_999, category: "equipment", txnId: linkedTxn });
    await createExpense({ taxYear: Y, item: "Laptop stand", amountCents: null, category: "equipment" });
    await createExpense({ taxYear: Y, item: "Office chair", amountCents: 12_800, paymentMethod: "Card + gift card", category: "furniture", businessPct: 50 });
    await createExpense({ taxYear: Y, datePurchased: `${Y}-03..${Y}-12`, item: "OpenAI API credits", amountCents: 15_000, category: "software" });

    let y = await businessYear(Y);
    expect(y.totals).toMatchObject({ spentCents: 52_799, deductibleCents: 46_399, count: 4, missingPriceCount: 1, linkedCount: 1, unlinkedCount: 3 });
    expect(y.expenses.find((e) => e.item === "Laptop stand")!.flags).toEqual(["price missing"]);
    expect(y.expenses.find((e) => e.item === "Office chair")!.flags).toEqual(["confirm gift-card portion"]);
    expect(y.byCategory[0]).toMatchObject({ category: "equipment", deductibleCents: 24_999, count: 2 });
    // Linked, refunded, covered-by-subscription, wrong category, and wrong year are all left out.
    expect(y.suggestions.map((s) => s.txnId)).toEqual([electronicsTxn]);
    expect(y.suggestions[0]).toMatchObject({ amountCents: 18_499, merchant: "Amazon", category: "Electronics" });
    expect(y.suggestions.some((s) => s.txnId === openAiTxn)).toBe(false);
    expect(y.sep.netProfitCents).toBe(540_000 - 46_399);

    await updateExpense(id, { businessPct: 50 });
    y = await businessYear(Y);
    const phones = y.expenses.find((e) => e.id === id)!;
    expect(phones).toMatchObject({ businessPct: 50, deductibleCents: 12_500, txnId: linkedTxn, category: "equipment" });

    await deleteExpense(id);
    y = await businessYear(Y);
    expect(y.totals.count).toBe(3);
    expect(y.suggestions.map((s) => s.txnId)).toEqual([electronicsTxn, linkedTxn]);
  });

  test("validation rejects bad input and unknown ids", async () => {
    await expect(createExpense({ taxYear: Y, item: "" })).rejects.toThrow();
    await expect(createExpense({ taxYear: Y, item: "x", businessPct: 101 })).rejects.toThrow();
    await expect(createExpense({ taxYear: Y, item: "x", bogus: 1 })).rejects.toThrow();
    await expect(updateExpense(999_999, { item: "x" })).rejects.toThrow(/No business expense/);
    await expect(deleteExpense(999_999)).rejects.toThrow(/No business expense/);
  });

  test("W-2 figures for the SEP math: no take-home model means unknown deferrals unless entered", async () => {
    expect(await w2ForSep(1999)).toEqual({ ssWagesCents: 0, ssWagesSource: "none entered ($0 assumed)", deferralsCents: null, deferralsSource: null });
    expect(await w2ForSep(1999, 500_000)).toMatchObject({ deferralsCents: 500_000, deferralsSource: "as entered" });
    const y = await businessYear(1999, { w2DeferralsCents: 500_000 });
    expect(y.sep.solo401k).toMatchObject({ w2Known: true, deferralRoomCents: 1_950_000 });
    expect(y.sep.w2Sources.deferrals).toBe("as entered");
  });

  test("an empty year is all zeros, not an error", async () => {
    const y = await businessYear(1999);
    expect(y.income.grossCents).toBe(0);
    expect(y.sep.sep.maxCents).toBe(0);
    expect(y.expenses).toEqual([]);
  });
});
