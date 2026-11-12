import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { autoCategorize, autoLine } from "./categorize-auto";
import { readRunLog } from "./categorize";

const { accounts, appConfig, categories, transactions } = schema;
const day = (d: number) => new Date(Date.UTC(2026, 4, d, 12));

// Other test files share this database: put back every row this file's runs touch.
let restore: { id: number; isTransfer: boolean }[] = [];
const ids: Record<string, number> = {};
const cat: Record<string, number> = {};
const savedEnv = process.env.AUTO_CATEGORIZE;

beforeAll(async () => {
  restore = await db.select({ id: transactions.id, isTransfer: transactions.isTransfer }).from(transactions).where(isNull(transactions.categoryId));
  const made = await db.insert(categories).values([
    { name: "AutoTest Fast Food", kind: "expense" },
    { name: "Credit Card Payment", kind: "transfer" },
    { name: "Account Transfer", kind: "transfer" },
  ]).returning();
  for (const c of made) cat[c.name] = c.id;
  const [brokerage, bank] = await db.insert(accounts).values([
    { name: "AutoTest brokerage", type: "brokerage", source: "manual" },
    { name: "AutoTest bank", type: "checking", source: "manual" },
  ]).returning();
  const rows = await db.insert(transactions).values([
    // The user filed this by hand as a card payment; a sync must not undo it even though the rule disagrees.
    { accountId: brokerage.id, postedAt: day(1), amountCents: 15500, merchantRaw: "Robinhood", payeeNormalized: "robinhood", categoryId: cat["Credit Card Payment"], categorySource: "manual" },
    { accountId: brokerage.id, postedAt: day(2), amountCents: -7000, merchantRaw: "Robinhood", payeeNormalized: "robinhood" },
    { accountId: bank.id, postedAt: day(3), amountCents: -15500, merchantRaw: "Robinhood", payeeNormalized: "robinhood" },
    // A hold the user filed, then its posted copy under a new id with a tip added.
    { accountId: bank.id, postedAt: day(4), amountCents: -2000, merchantRaw: "Wingstop 1234", payeeNormalized: "wingstop", isPending: true, categoryId: made[0].id, categorySource: "manual" },
    { accountId: bank.id, postedAt: day(5), amountCents: -2300, merchantRaw: "Wingstop", payeeNormalized: "wingstop" },
  ]).returning();
  ["manual", "cardPay", "deposit", "hold", "posted"].forEach((k, i) => (ids[k] = rows[i].id));
});

afterAll(async () => {
  for (const r of restore) {
    await db.update(transactions).set({ categoryId: null, categorySource: "uncategorized", categoryConfidence: null, isTransfer: r.isTransfer }).where(eq(transactions.id, r.id));
  }
  await db.delete(transactions).where(inArray(transactions.id, Object.values(ids)));
  await db.delete(appConfig).where(eq(appConfig.key, "categorize_log"));
  if (savedEnv === undefined) delete process.env.AUTO_CATEGORIZE;
  else process.env.AUTO_CATEGORIZE = savedEnv;
});

const row = async (id: number) => db.select().from(transactions).where(eq(transactions.id, id)).get();
const noTransfers = async () => ({ marked: 0 });

describe("auto-categorize after a sync", () => {
  test("off does nothing", async () => {
    process.env.AUTO_CATEGORIZE = "off";
    expect(await autoCategorize({ transfers: noTransfers })).toEqual({ mode: "off" });
    expect((await row(ids.cardPay))?.categoryId).toBeNull();
  });

  test("rules mode files new rows offline, account- and sign-aware, and never touches a manual row", async () => {
    process.env.AUTO_CATEGORIZE = "rules";
    const r = await autoCategorize({ transfers: noTransfers });
    expect(r.mode).toBe("rules");
    expect("summary" in r && r.summary.usedAI).toBe(false);
    expect(await row(ids.manual)).toMatchObject({ categoryId: cat["Credit Card Payment"], categorySource: "manual" });
    expect(await row(ids.cardPay)).toMatchObject({ categoryId: cat["Credit Card Payment"], categorySource: "builtin", isTransfer: true });
    expect(await row(ids.deposit)).toMatchObject({ categoryId: cat["Account Transfer"], categorySource: "builtin" });
    expect(autoLine(r)).toContain("auto-categorize (rules)");
  });

  test("a posted row inherits its pending hold's category", async () => {
    expect(await row(ids.posted)).toMatchObject({ categoryId: cat["AutoTest Fast Food"], categorySource: "history" });
  });

  test("the run is logged with counts by layer", async () => {
    const [last] = await readRunLog();
    expect(last).toMatchObject({ trigger: "sync" });
    expect(last.byBuiltin).toBeGreaterThanOrEqual(2);
    expect(last.byHistory).toBeGreaterThanOrEqual(1);
  });

  test("a categorisation failure is one log line and a result, never a thrown sync", async () => {
    process.env.AUTO_CATEGORIZE = "rules";
    const lines: string[] = [];
    const r = await autoCategorize({
      transfers: noTransfers,
      run: async () => { throw new Error("database is locked"); },
      log: (l) => lines.push(l),
    });
    expect(r).toEqual({ mode: "rules", error: "database is locked" });
    expect(lines).toEqual(["auto-categorize failed (rules): database is locked"]);
    expect(autoLine(r)).toBe("auto-categorize failed: database is locked");
    expect((await readRunLog())[0].skipped).toBe("database is locked");
  });

  test("ai mode without a provider key falls back to rules", async () => {
    process.env.AUTO_CATEGORIZE = "ai";
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "NIM_API_KEY"];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    let noAI: boolean | undefined;
    try {
      await autoCategorize({ transfers: noTransfers, run: async (o) => { noAI = o?.noAI; throw new Error("stop"); }, log: () => {} });
    } finally {
      keys.forEach((k, i) => { if (saved[i] !== undefined) process.env[k] = saved[i]; });
    }
    expect(noAI).toBe(true);
  });
});
