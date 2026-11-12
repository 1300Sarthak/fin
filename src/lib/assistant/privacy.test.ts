import { beforeAll, describe, expect, test } from "bun:test";
import { db, schema, seed } from "./test-db";

const { detectPerson, brand, loadPrivacy } = await import("./privacy");
const { runAssistantTool } = await import("./tools");
const { runAssistant } = await import("./agent");
const { buildAssistantContext } = await import("./context");
type Opts = Parameters<typeof import("@/lib/ai").complete>[0];
type Result = Awaited<ReturnType<typeof import("@/lib/ai").complete>>;

const SLOW = 60_000;
const NOV = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
/** Everything that must never reach the provider. */
const LEAKS = ["Dana", "Whitford", "Marcus", "Kline", "Tamsin", "7Tamsin", "4321", "dana.w@example.com", "408-555-0199", "ZX9Q81", "memo-gig-secret", "Quinn"];
const leaksIn = (s: string) => LEAKS.filter((l) => s.toLowerCase().includes(l.toLowerCase()));

let ids: { dana: number; marcus: number; safeway: number; uber: number; quinn: number; acct: number };

beforeAll(async () => {
  const s = await seed();
  const [acct] = await db.insert(schema.accounts).values({ name: "7Tamsin (4321)", type: "checking", source: "simplefin", currentBalanceCents: 120000 }).returning();
  const income = (await db.insert(schema.categories).values({ name: "Side income", kind: "income" }).returning())[0];
  const rows = await db.insert(schema.transactions).values([
    { accountId: acct.id, postedAt: NOV(9), amountCents: 120000, merchantRaw: "Zelle Transfer from Dana Kline Whitford for \"gig\"; Conf# ZX9Q81", payeeNormalized: "zelle dana", memo: "memo-gig-secret dana.w@example.com", note: "call 408-555-0199", categoryId: income.id, source: "simplefin" },
    { accountId: acct.id, postedAt: NOV(5), amountCents: 50000, merchantRaw: "Zelle Transfer from Marcus Whitford for \"gig\"; Conf#", payeeNormalized: "zelle marcus", categoryId: s.cat("Transfer"), source: "simplefin" },
    { accountId: acct.id, postedAt: NOV(4), amountCents: -4512, merchantRaw: "Safeway", payeeNormalized: "safeway", categoryId: s.cat("Groceries"), source: "simplefin" },
    { accountId: acct.id, postedAt: NOV(3), amountCents: -1820, merchantRaw: "Uber", payeeNormalized: "uber", source: "simplefin" },
    { accountId: acct.id, postedAt: NOV(2), amountCents: -2000, merchantRaw: "Zelle Transfer to Quinn", payeeNormalized: "zelle quinn", categoryId: s.cat("Transfer"), source: "simplefin" },
  ]).returning();
  ids = { dana: rows[0].id, marcus: rows[1].id, safeway: rows[2].id, uber: rows[3].id, quinn: rows[4].id, acct: acct.id };
  const [src] = await db.insert(schema.incomeSources).values({ name: "Studio", matchPattern: "Whitford", note: "paid by Dana Kline Whitford" }).returning();
  await db.insert(schema.incomeEntries).values({ sourceId: src.id, amountCents: 120000, paidOn: "2026-11-09", txnId: rows[0].id, note: "Zelle from a person (Studio)" });
  await db.insert(schema.tripBookings).values({ kind: "hotel", provider: "Marriott", title: "2 nights for Marcus Whitford", startDate: "2026-11-20", costCents: 30000, note: "conf 88812345, dana.w@example.com" });
  await db.insert(schema.notes).values({ kind: "todo", body: "Ask Dana about the Nov Studio payment into 7Tamsin (4321)" });
}, SLOW);

describe("person vs business", () => {
  test("payment-app counterparties and named transfers are people", () => {
    expect(detectPerson("Zelle Transfer from Dana Kline Whitford for \"gig\"; Conf#")?.name).toBe("Dana Kline Whitford");
    expect(detectPerson("Zelle Transfer to Quinn")?.name).toBe("Quinn");
    expect(detectPerson("Venmo from Sam")).toMatchObject({ name: "Sam", channel: "Venmo", direction: "from" });
    expect(detectPerson("Transfer Ravi Mehta")?.name).toBe("Ravi Mehta");
    expect(detectPerson("Jane Doe", { transfer: true })?.name).toBe("Jane Doe");
    expect(detectPerson("thai food with rochu")?.name).toBe("rochu");
  });

  test("businesses, own-account transfers and payroll are not", () => {
    for (const m of ["Safeway", "Uber", "Taco Bell", "Best Buy", "Transfer to Savings", "Transfer from Venmo", "Venmo to card", "Transfer To Checking 0246",
      "Online Banking Transfer From Sav Confirmation", "Acme Payroll", "Electronic Funds Transfer Received", "Transfer to Apple Pay", "mom cash and gift card"]) {
      expect({ m, hit: detectPerson(m, { businesses: new Set(["acme"]) }) }).toEqual({ m, hit: null });
    }
    expect(detectPerson("Referral Bonus", { transfer: true })).toBeNull();
    expect(detectPerson("Acme Corp", { transfer: true })).toBeNull();
  });

  test("brand drops memos, codes and wallet noise", () => {
    expect(brand("Elemental Pizza U Seattle Waapple Pay Ending in")).toBe("Elemental Pizza U Seattle");
    expect(brand("Mobile Thai Canteen Restaurant")).toBe("Thai Canteen Restaurant");
  });
});

describe("outbound payloads", () => {
  test("snapshot, search and every row-level fin read carry no names, numbers, emails or codes", async () => {
    const priv = await loadPrivacy();
    const outputs: Record<string, string> = { context: priv.scrubText(await buildAssistantContext("2026-11-11")) };
    outputs.search = await runAssistantTool("search_transactions", { text: "zelle", limit: 40 }, [], priv);
    outputs.searchAll = await runAssistantTool("search_transactions", { limit: 40 }, [], priv);
    outputs.merchants = await runAssistantTool("top_merchants", { month: "2026-11" }, [], priv);
    for (const command of ["txns", "accounts", "income", "activity", "trips", "transfers", "pending", "burn", "earnings", "note", "context"]) {
      outputs[command] = await runAssistantTool("get_fin", { command, ...(command === "note" ? { args: ["list"] } : {}) }, [], priv);
    }
    for (const [name, out] of Object.entries(outputs)) expect({ name, leaks: leaksIn(out) }).toEqual({ name, leaks: [] });
    // A failing CLI would make this vacuous: every read must have returned data.
    for (const [name, out] of Object.entries(outputs)) expect({ name, error: /^\{"error"/.test(out) }).toEqual({ name, error: false });
    // Still useful: the money, the brand names and the tokens are there.
    const rows = JSON.parse(outputs.search).transactions as { id: number; merchant: string; account: string; account_type: string }[];
    const dana = rows.find((r) => r.id === ids.dana)!;
    expect(dana.merchant).toMatch(/^Zelle from ⟦person:\d+⟧$/);
    expect(dana.account).toBe(`⟦acct:${ids.acct}⟧`);
    expect(dana.account_type).toBe("checking");
    expect(outputs.searchAll).toContain("Safeway");
    expect(outputs.searchAll).toContain("Uber");
    expect(outputs.txns).not.toContain("memo");
    expect(outputs.income).toContain("120000");
    expect(priv.rehydrate(dana.merchant)).toBe("Zelle from Dana Kline Whitford");
  }, SLOW);

  test("long lists become a sample plus category and merchant totals", async () => {
    const priv = await loadPrivacy();
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, date: "2026-11-01", amountCents: -100, merchant: i % 2 ? "Safeway" : "Zelle Transfer to Quinn", category: i % 2 ? "Groceries" : "Transfer", memo: "secret" }));
    const out = priv.minimize(rows) as { rows: unknown[]; omittedRows: number; summary: { count: number; total: number; byMerchant: { name: string }[] } };
    expect(out.rows).toHaveLength(20);
    expect(out.omittedRows).toBe(30);
    expect(out.summary).toMatchObject({ count: 50, total: -5000 });
    const names = out.summary.byMerchant.map((m) => m.name);
    expect(names).toContain("Safeway");
    expect(names.find((n) => n !== "Safeway")).toMatch(/^Zelle to ⟦person:\d+⟧$/);
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(priv.rowsAggregated).toBe(30);
  });
});

describe("agent loop", () => {
  test("two turns: nothing private leaves, the answer is rehydrated, and a proposal hits the real row", async () => {
    const sent: string[] = [];
    let step = 0;
    const complete = async (o: Opts): Promise<Result> => {
      sent.push(JSON.stringify({ system: o.system, messages: o.messages.filter((m) => m.role !== "user") }));
      step++;
      const base = { provider: "nim" as const, model: "m", stopReason: "end" as const };
      if (step === 1) return { ...base, text: "", stopReason: "tool_use", toolCalls: [{ id: "a", name: "search_transactions", input: { text: "zelle", month: "2026-11" } }] };
      const rows = JSON.parse(o.messages.at(-1)!.content).transactions as { id: number; merchant: string; account: string }[];
      const dana = rows.find((r) => r.id === ids.dana)!;
      const person = /⟦person:\d+⟧/.exec(dana.merchant)![0];
      if (step === 2) return { ...base, text: "", stopReason: "tool_use", toolCalls: [
        { id: "b", name: "propose_recategorize", input: { txn_id: dana.id, category_name: "Paycheck" } },
        { id: "c", name: "search_transactions", input: { text: person } },
      ] };
      const found = JSON.parse(o.messages.at(-1)!.content).transactions as { id: number }[];
      expect(found.map((r) => r.id)).toEqual([ids.dana]); // the token was searched as the real name
      return { ...base, text: `${person} paid you $1,200 into ${dana.account} on 2026-11-09. I've proposed moving it to Paycheck.`, toolCalls: [] };
    };
    const first = await runAssistant([{ role: "user", content: "How much Studio income came in by Zelle this month?" }], undefined, { complete });
    expect(first.reply).toBe("Dana Kline Whitford paid you $1,200 into 7Tamsin (4321) on 2026-11-09. I've proposed moving it to Paycheck.");
    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]).toMatchObject({ kind: "recategorize", status: "proposed", txn: { id: ids.dana } });
    expect(first.privacy.provider).toBe("nim");
    expect(first.privacy.redactions.accounts).toBeGreaterThan(0);
    expect(first.privacy.redactions.people).toBeGreaterThan(0);
    expect(first.privacy.sentChars).toBeGreaterThan(0);
    expect(leaksIn(first.privacy.preview ?? "")).toEqual([]);

    // Turn two re-sends the rehydrated answer; it must be pseudonymised again.
    step = 2;
    const second = await runAssistant([
      { role: "user", content: "How much Studio income came in by Zelle this month?" },
      { role: "assistant", content: first.reply },
      { role: "user", content: "And who else paid by Zelle?" },
    ], undefined, { complete: async (o) => { sent.push(JSON.stringify({ system: o.system, messages: o.messages.filter((m) => m.role !== "user") })); return { provider: "nim", model: "m", stopReason: "end", toolCalls: [], text: "⟦person:999⟧ is unknown; ask again." }; } });
    expect(second.reply).toBe("⟦person:999⟧ is unknown; ask again.");
    for (const s of sent) expect(leaksIn(s)).toEqual([]);
    await db.update(schema.ledgerChanges).set({ status: "discarded" });
  }, SLOW);
});
