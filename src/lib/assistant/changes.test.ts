import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MONTH, db, dir, schema, seed } from "./test-db";

// Loaded after test-db has pointed DATABASE_URL at the temp file and stubbed server-only.
const { monthRange, getCashflow, getSpendingByCategory } = await import("@/lib/spending");
const { autoDetectRefunds, findRefundCandidates } = await import("@/lib/refunds");
const { ingestAccounts } = await import("@/lib/ingest/adapter");
const {
  applyChange, backupDatabase, discardChange, listChanges, proposeExclude, proposeReimbursement, proposeRecategorize,
  proposeSplit, undoChange,
} = await import("./changes");
type ChangeError = InstanceType<typeof import("./changes").ChangeError>;

const { transactions, ledgerChanges, categoryRules, merchantCache, accounts, balanceSnapshots } = schema;
let s: Awaited<ReturnType<typeof seed>>;
const range = () => monthRange(MONTH);
const spentIn = async (name: string) => (await getSpendingByCategory(range())).find((c) => c.name === name)?.spentCents ?? 0;
const txn = (id: number) => db.select().from(transactions).where(eq(transactions.id, id)).get();
const splitRows = () => db.select().from(transactions).where(eq(transactions.source, "split"));
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ChangeError);

beforeAll(async () => { s = await seed(); });

describe("split", () => {
  test("spending drops by exactly T-S, re-split updates in place, undo restores", async () => {
    expect(await spentIn("Restaurants")).toBe(10000);
    const cash0 = (await getCashflow(range())).spendingCents;

    const first = await applyChange((await proposeSplit(s.dinner.id, 2500)).id);
    expect(first.status).toBe("applied");
    const row = (await splitRows())[0];
    expect(row).toMatchObject({ amountCents: 7500, source: "split", externalId: null, isRefund: true, refundsTxnId: s.dinner.id, accountId: s.dinner.accountId, categoryId: s.dinner.categoryId });
    expect(row.postedAt.getTime()).toBe(s.dinner.postedAt.getTime());
    expect(row.merchantRaw).toBe("Split reimbursement: Dinner at Luigi's");
    expect(await spentIn("Restaurants")).toBe(2500);
    expect((await getCashflow(range())).spendingCents).toBe(cash0 - 7500);

    const second = await applyChange((await proposeSplit(s.dinner.id, 4000)).id);
    expect(await splitRows()).toHaveLength(1);
    expect((await splitRows())[0].amountCents).toBe(6000);
    expect(await spentIn("Restaurants")).toBe(4000);

    await undoChange(second.id);
    expect((await splitRows())[0].amountCents).toBe(7500);
    expect(await spentIn("Restaurants")).toBe(2500);
    await undoChange(first.id);
    expect(await splitRows()).toHaveLength(0);
    expect(await spentIn("Restaurants")).toBe(10000);
    expect((await getCashflow(range())).spendingCents).toBe(cash0);
  });

  test("rejects shares that are negative, equal to or above the total, fractional cents, and non-purchases", async () => {
    for (const bad of [-1, 10000, 10001, 12.5]) expect((await refusal(proposeSplit(s.dinner.id, bad)))?.code).toBe("invalid");
    expect((await refusal(proposeSplit(s.payroll.id, 100)))?.code).toBe("invalid");
    expect((await refusal(proposeSplit(99999, 100)))?.code).toBe("notfound");
    const transfer = (await db.insert(transactions).values({ accountId: s.checking.id, postedAt: new Date(Date.UTC(2026, 2, 3, 12)), amountCents: -900, merchantRaw: "To savings", isTransfer: true }).returning())[0];
    expect((await refusal(proposeSplit(transfer.id, 100)))?.code).toBe("invalid");
  });

  test("balances, snapshots and refund detection are untouched by a split row", async () => {
    const balances = JSON.stringify(await db.select().from(accounts));
    const snaps = JSON.stringify(await db.select().from(balanceSnapshots));
    const c = await applyChange((await proposeSplit(s.dinner.id, 2500)).id);
    expect(JSON.stringify(await db.select().from(accounts))).toBe(balances);
    expect(JSON.stringify(await db.select().from(balanceSnapshots))).toBe(snaps);

    const before = (await splitRows())[0];
    await autoDetectRefunds();
    expect((await findRefundCandidates()).some((x) => x.id === before.id)).toBe(false);
    expect(await txn(before.id)).toMatchObject({ isRefund: true, refundsTxnId: s.dinner.id, amountCents: 7500 });
    await undoChange(c.id);
  });

  test("a sync never overwrites, adopts or deletes a split row", async () => {
    const c = await applyChange((await proposeSplit(s.dinner.id, 2500)).id);
    const row = (await splitRows())[0];
    const feed = (txns: { externalId: string; amountCents: number; merchantRaw: string }[]) => ingestAccounts([{
      externalId: "SECRET-ACCT-EXT", name: "Checking", type: "checking", currency: "USD", balanceCents: 500000, balanceDate: new Date(),
      institution: { name: "Bank" }, transactions: txns.map((t) => ({ ...t, postedAt: row.postedAt, payeeNormalized: t.merchantRaw.toLowerCase() })),
    }], "simplefin");
    // A brand-new provider row with the same instant and amount: the lookalike a reissue match would grab.
    await feed([{ externalId: "NEW-LOOKALIKE", amountCents: 7500, merchantRaw: "Lookalike" }]);
    expect(await txn(row.id)).toMatchObject({ externalId: null, source: "split", merchantRaw: "Split reimbursement: Dinner at Luigi's", amountCents: 7500 });
    expect(await db.select().from(transactions).where(eq(transactions.externalId, "NEW-LOOKALIKE"))).toHaveLength(1);
    await feed([]);
    expect(await splitRows()).toHaveLength(1);
    await undoChange(c.id);
  });
});

describe("safety rails", () => {
  test("a stale proposal is refused and changes nothing", async () => {
    const c = await proposeExclude(s.market.id, true);
    await db.update(transactions).set({ isExcluded: true }).where(eq(transactions.id, s.market.id));
    const e = await refusal(applyChange(c.id));
    expect(e?.code).toBe("stale");
    expect((await db.select().from(ledgerChanges).where(eq(ledgerChanges.id, c.id)).get())?.status).toBe("proposed");
    await db.update(transactions).set({ isExcluded: false }).where(eq(transactions.id, s.market.id));
  });

  test("a purchase edited after a split proposal is refused as stale", async () => {
    const c = await proposeSplit(s.dinner.id, 2500);
    await db.update(transactions).set({ amountCents: -12000 }).where(eq(transactions.id, s.dinner.id));
    expect((await refusal(applyChange(c.id)))?.code).toBe("stale");
    expect(await splitRows()).toHaveLength(0);
    await db.update(transactions).set({ amountCents: -10000 }).where(eq(transactions.id, s.dinner.id));
  });

  test("a discarded or expired proposal never applies", async () => {
    const d = await proposeExclude(s.market.id, true);
    await discardChange(d.id);
    expect((await refusal(applyChange(d.id)))?.code).toBe("state");

    const x = await proposeExclude(s.market.id, true);
    await db.update(ledgerChanges).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(ledgerChanges.id, x.id));
    expect((await refusal(applyChange(x.id)))?.code).toBe("state");
    expect((await db.select().from(ledgerChanges).where(eq(ledgerChanges.id, x.id)).get())?.status).toBe("discarded");
    expect((await txn(s.market.id))?.isExcluded).toBe(false);
    expect((await refusal(applyChange(x.id)))?.code).toBe("state");
  });

  test("applying twice, or undoing something unapplied, is refused", async () => {
    const c = await proposeExclude(s.market.id, true);
    await applyChange(c.id);
    expect((await refusal(applyChange(c.id)))?.code).toBe("state");
    await undoChange(c.id);
    expect((await refusal(undoChange(c.id)))?.code).toBe("state");
    expect((await txn(s.market.id))?.isExcluded).toBe(false);
  });

  test("undo refuses when the row was edited again afterwards", async () => {
    const c = await applyChange((await proposeExclude(s.market.id, true)).id);
    await db.update(transactions).set({ isExcluded: false }).where(eq(transactions.id, s.market.id));
    expect((await refusal(undoChange(c.id)))?.code).toBe("stale");
  });

  test("every apply takes a backup, restorable and capped at 30", async () => {
    const dirPath = join(dir, "backups");
    const before = readdirSync(dirPath).length;
    const c = await proposeExclude(s.market.id, true);
    await applyChange(c.id);
    expect(readdirSync(dirPath).length).toBe(Math.min(before + 1, 30));
    expect(statSync(dirPath).mode & 0o777).toBe(0o700);
    for (let i = 0; i < 32; i++) await backupDatabase();
    expect(readdirSync(dirPath).length).toBe(30);
    await undoChange(c.id);
  });
});

describe("recategorize", () => {
  test("undo restores the category, source, and any rule or cache entry it touched", async () => {
    const t = s.market;
    await db.insert(categoryRules).values({ pattern: t.payeeNormalized, categoryId: s.cat("Restaurants"), createdBy: "user", priority: 10 });
    const rules0 = JSON.stringify(await db.select().from(categoryRules));
    const cache0 = JSON.stringify(await db.select().from(merchantCache));
    const c = await applyChange((await proposeRecategorize(t.id, s.cat("Restaurants"))).id);
    expect(await txn(t.id)).toMatchObject({ categoryId: s.cat("Restaurants"), categorySource: "manual" });
    expect(c.after.remembered).toBe(true);
    expect(JSON.stringify(await db.select().from(merchantCache))).not.toBe(cache0);
    await undoChange(c.id);
    expect(await txn(t.id)).toMatchObject({ categoryId: s.cat("Groceries"), categorySource: t.categorySource });
    expect(JSON.stringify(await db.select().from(categoryRules))).toBe(rules0);
    expect(JSON.stringify(await db.select().from(merchantCache))).toBe(cache0);
  });

  test("a rule created by the change is removed by undo", async () => {
    const t = s.evil;
    const rules0 = (await db.select().from(categoryRules)).length;
    const c = await applyChange((await proposeRecategorize(t.id, s.cat("Restaurants"))).id);
    expect((await db.select().from(categoryRules)).length).toBe(rules0 + 1);
    await undoChange(c.id);
    expect((await db.select().from(categoryRules)).length).toBe(rules0);
    expect((await db.select().from(merchantCache).where(eq(merchantCache.normalizedMerchant, "evil")))).toHaveLength(0);
  });
});

describe("reimbursement", () => {
  test("links an incoming payment to the purchase, nets spending, and is undoable", async () => {
    const buy = (await db.insert(transactions).values({ accountId: s.checking.id, postedAt: new Date(Date.UTC(2026, 2, 6, 12)), amountCents: -8000, merchantRaw: "Cabin", payeeNormalized: "cabin", categoryId: s.cat("Restaurants") }).returning())[0];
    const base = await spentIn("Restaurants");
    const c = await applyChange((await proposeReimbursement(s.venmo.id, buy.id)).id);
    expect(await txn(s.venmo.id)).toMatchObject({ isRefund: true, refundsTxnId: buy.id });
    expect(await spentIn("Restaurants")).toBe(base - 7500);
    // The same money cannot also be split.
    expect((await refusal(proposeSplit(buy.id, 100)))?.code).toBe("invalid");
    await undoChange(c.id);
    expect(await txn(s.venmo.id)).toMatchObject({ isRefund: false, refundsTxnId: null });
    expect(await spentIn("Restaurants")).toBe(base);
  });

  test("refuses a split purchase, a payment on another account, and a payment dated before the purchase", async () => {
    const c = await applyChange((await proposeSplit(s.dinner.id, 2500)).id);
    expect((await refusal(proposeReimbursement(s.venmo.id, s.dinner.id)))?.code).toBe("invalid");
    await undoChange(c.id);
    expect((await refusal(proposeReimbursement(s.cardCredit.id, s.dinner.id)))?.message).toMatch(/same account/);
    expect((await refusal(proposeReimbursement(s.venmo.id, s.payroll.id)))?.code).toBe("invalid");
    const early = (await db.insert(transactions).values({ accountId: s.checking.id, postedAt: new Date(Date.UTC(2026, 2, 20, 12)), amountCents: -1000, merchantRaw: "Late", payeeNormalized: "late" }).returning())[0];
    expect((await refusal(proposeReimbursement(s.venmo.id, early.id)))?.message).toMatch(/after the purchase/);
  });
});

describe("listing and audit", () => {
  test("lists changes for the month, newest first, without internal snapshots", async () => {
    const c = await applyChange((await proposeRecategorize(s.market.id, s.cat("Restaurants"))).id);
    const list = await listChanges(MONTH);
    expect(list[0].id).toBeGreaterThan(list[list.length - 1].id);
    const found = list.find((x) => x.id === c.id)!;
    expect(found.txn).toMatchObject({ id: s.market.id, date: "2026-03-12", merchant: "Market" });
    expect(found.after.snapshot).toBeUndefined();
    expect(await listChanges("2026-01")).toHaveLength(0);
    await undoChange(c.id);
  });
});

describe("review fixes", () => {
  const add = async (v: Partial<typeof transactions.$inferInsert> & { amountCents: number; postedAt: Date; merchantRaw: string }) =>
    (await db.insert(transactions).values({ accountId: s.checking.id, categoryId: s.cat("Groceries"), payeeNormalized: v.merchantRaw.toLowerCase(), ...v }).returning())[0];
  const date = (d: number) => new Date(Date.UTC(2026, 2, d, 12));

  test("split and reimbursement never both count the same purchase (either order)", async () => {
    const base = await spentIn("Groceries");
    const a = await add({ amountCents: -10000, postedAt: date(2), merchantRaw: "Cabin A" });
    const payA = await add({ amountCents: 3000, postedAt: date(3), merchantRaw: "Venmo A", categoryId: null });
    const split = await proposeSplit(a.id, 5000);
    const reimb = await proposeReimbursement(payA.id, a.id);
    await applyChange(split.id);
    expect((await refusal(applyChange(reimb.id)))?.code).toBe("stale");
    expect((await txn(payA.id))?.isRefund).toBe(false);
    expect(await spentIn("Groceries")).toBe(base + 5000);
    await undoChange(split.id);

    const b = await add({ amountCents: -10000, postedAt: date(2), merchantRaw: "Cabin B" });
    const payB = await add({ amountCents: 3000, postedAt: date(3), merchantRaw: "Venmo B", categoryId: null });
    const split2 = await proposeSplit(b.id, 5000);
    await applyChange((await proposeReimbursement(payB.id, b.id)).id);
    expect((await refusal(applyChange(split2.id)))?.code).toBe("stale");
    expect((await refusal(proposeSplit(b.id, 5000)))?.code).toBe("invalid");
    expect(await splitRows()).toHaveLength(0);
    expect(await spentIn("Groceries")).toBe(base + 10000 + 7000);
  });

  test("a split row does not change a cash account's rebuilt balance", async () => {
    const { createCashTransaction } = await import("@/lib/cash");
    const when = date(4);
    await createCashTransaction({ direction: "add", amountCents: 10000, postedAt: when, note: "ATM" });
    const spend = (await createCashTransaction({ direction: "spend", amountCents: 4000, postedAt: new Date(when.getTime() + 1000), note: "Pizza" })).transaction;
    const c = await applyChange((await proposeSplit(spend.id, 1000)).id);
    const { balanceCents } = await createCashTransaction({ direction: "add", amountCents: 100, postedAt: new Date(when.getTime() + 2000), note: "Found" });
    expect(balanceCents).toBe(6100);
    const cash = await db.select().from(accounts).where(eq(accounts.id, spend.accountId)).get();
    expect(cash?.currentBalanceCents).toBe(6100);
    await undoChange(c.id);
  });

  test("generic ledger mutators refuse a split row", async () => {
    const { setRefund } = await import("@/lib/refunds");
    const { setExcluded } = await import("@/lib/ledger");
    const { setManualCategory } = await import("@/lib/categorize");
    const { deleteCashTransaction } = await import("@/lib/cash");
    const c = await applyChange((await proposeSplit(s.dinner.id, 2500)).id);
    const row = (await splitRows())[0];
    for (const op of [() => setRefund(row.id, false), () => setExcluded(row.id, true), () => setManualCategory(row.id, s.cat("Groceries")), () => deleteCashTransaction(row.id)])
      await expect(op()).rejects.toThrow(/undo the split instead|Cash account does not exist|Cash transaction not found/);
    await expect(setRefund(row.id, false)).rejects.toThrow(/undo the split/);
    expect(await txn(row.id)).toMatchObject({ isRefund: true, refundsTxnId: s.dinner.id, amountCents: 7500 });
    await undoChange(c.id);
    expect(await splitRows()).toHaveLength(0);
  });

  test("pending purchases and payments cannot be split or reimbursed", async () => {
    const p = await add({ amountCents: -5000, postedAt: date(6), merchantRaw: "Hold", isPending: true });
    expect((await refusal(proposeSplit(p.id, 1000)))?.message).toMatch(/pending/);
    const pay = await add({ amountCents: 500, postedAt: date(7), merchantRaw: "Pending pay", isPending: true, categoryId: null });
    expect((await refusal(proposeReimbursement(pay.id, s.market.id)))?.message).toMatch(/Pending/);
  });

  test("a sync restating the purchase amount keeps the user's share fixed", async () => {
    const c = await applyChange((await proposeSplit(s.dinner.id, 2500)).id);
    const feed = (amountCents: number) => ingestAccounts([{
      externalId: "SECRET-ACCT-EXT", name: "Checking", type: "checking", currency: "USD", balanceCents: 500000, balanceDate: new Date(), institution: { name: "Bank" },
      transactions: [{ externalId: "SECRET-TXN-EXT-1", postedAt: s.dinner.postedAt, amountCents, merchantRaw: "Dinner at Luigi's", payeeNormalized: "dinner at luigi's" }],
    }], "simplefin");
    const base = await spentIn("Restaurants");
    await feed(-12000);
    expect((await splitRows())[0].amountCents).toBe(9500);
    expect(await spentIn("Restaurants")).toBe(base);
    await feed(-10000);
    expect((await splitRows())[0].amountCents).toBe(7500);
    await undoChange(c.id);
  });

  test("undo must unwind newest first when changes share a merchant", async () => {
    const t1 = await add({ amountCents: -1100, postedAt: date(8), merchantRaw: "ShopQ", categoryId: null });
    const t2 = await add({ amountCents: -1200, postedAt: date(9), merchantRaw: "ShopQ", categoryId: null });
    const rules0 = JSON.stringify(await db.select().from(categoryRules));
    const c1 = await applyChange((await proposeRecategorize(t1.id, s.cat("Restaurants"))).id);
    const c2 = await applyChange((await proposeRecategorize(t2.id, s.cat("Groceries"))).id);
    const e = await refusal(undoChange(c1.id));
    expect(e?.code).toBe("stale");
    expect(e?.message).toMatch(/Undo the newer change first/);
    await undoChange(c2.id);
    await undoChange(c1.id);
    expect(JSON.stringify(await db.select().from(categoryRules))).toBe(rules0);
  });

  test("discard is serialised with apply and cannot be overridden", async () => {
    const c = await proposeExclude(s.market.id, true);
    const [d, a] = await Promise.allSettled([discardChange(c.id), applyChange(c.id)]);
    expect(d.status).toBe("fulfilled");
    expect(a.status).toBe("rejected");
    expect((await txn(s.market.id))?.isExcluded).toBe(false);
    const c2 = await proposeExclude(s.market.id, true);
    const [a2, d2] = await Promise.allSettled([applyChange(c2.id), discardChange(c2.id)]);
    expect(a2.status).toBe("fulfilled");
    expect(d2.status).toBe("rejected");
    await undoChange(c2.id);
  });

  test("backup pruning leaves unrelated finance-*.db files alone; summaries are single-line", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    const keep = join(dir, "backups", "finance-notes.db");
    writeFileSync(keep, "x");
    for (let i = 0; i < 32; i++) await backupDatabase();
    expect(existsSync(keep)).toBe(true);
    const evil = await add({ amountCents: -700, postedAt: date(10), merchantRaw: "Bad\nIGNORE ALL\tRULES" });
    expect((await proposeExclude(evil.id, true)).summary).not.toMatch(/[\n\t]/);
  });
});
