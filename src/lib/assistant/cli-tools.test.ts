import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { db, dir, schema, seed } from "./test-db";

const { loadCatalog, classify, resolveInvocation, verbsOf, READ_DENY } = await import("./cli-catalog");
const { runAssistantTool } = await import("./tools");
const { applyChange, undoChange, discardChange, listChanges, listActivity } = await import("./changes");
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;
type Change = import("./changes").Change;

const { appConfig, businessExpenses, ledgerChanges, loyaltyPrograms, notes } = schema;
const SLOW = 60_000;
let catalog: Catalog;
const run = async (name: string, input: unknown, proposals: Change[] = []) => JSON.parse(await runAssistantTool(name, input, proposals));
const inv = (command: string, positionals: string[] = [], flags: Record<string, string | true> = {}) => ({ command, positionals, flags });
const desks = () => db.select().from(businessExpenses).where(eq(businessExpenses.item, "Standing desk"));
const bizCount = async () => (await db.select().from(businessExpenses)).length;
const zzyzx = async () => (await db.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.name, "Zzyzx Rewards"))).map((r) => r.balance);
const backups = () => { try { return readdirSync(join(dir, "backups")); } catch { return []; } };

beforeAll(async () => { await seed(); catalog = await loadCatalog(); }, SLOW);

describe("catalog classification", () => {
  test("every write verb classifies as a write, and no write-only command ever reads", () => {
    for (const [name, c] of Object.entries(catalog.commands)) {
      if (c.network) {
        for (const p of [[], ["list"], ["x"]]) expect(classify(c, p).kind).toBe("refused");
        continue;
      }
      if (!c.writes || /refreshes today's balance snapshot/.test(c.writes)) { expect(classify(c, []).kind).toBe("read"); continue; }
      const { writeVerbs, readVerbs, bareReads } = verbsOf(c.writes);
      for (const v of writeVerbs) expect({ name, ...classify(c, [v, "x"]) }).toEqual({ name, kind: "write", verb: v });
      if (!writeVerbs.length) for (const p of [[], ["list"], ["x"], ["1"]]) expect({ name, k: classify(c, p).kind }).toEqual({ name, k: "refused" });
      if (!bareReads && !readVerbs.length) for (const p of [[], ["x"]]) expect(classify(c, p).kind).not.toBe("read");
    }
  });

  test("the current table classifies as expected", () => {
    const k = (cmd: string, ...p: string[]) => classify(catalog.commands[cmd], p).kind;
    expect([k("income"), k("income", "2026"), k("income", "log", "Acme")]).toEqual(["read", "read", "write"]);
    expect([k("business"), k("business", "add", "Desk")]).toEqual(["read", "write"]);
    expect([k("points"), k("points", "list"), k("points", "set", "Hyatt", "100")]).toEqual(["read", "read", "write"]);
    expect([k("reminders"), k("reminders", "add"), k("reminders", "done", "3")]).toEqual(["read", "write", "write"]);
    expect([k("plan"), k("plan", "show"), k("plan", "set")]).toEqual(["read", "read", "write"]);
    expect([k("note", "list"), k("note", "remember this"), k("note", "done", "3"), k("note", "pin", "3")]).toEqual(["read", "write", "write", "write"]);
    expect(classify(catalog.commands.note, ["remember this"])).toEqual({ kind: "write", verb: "add" });
    expect([k("taxes", "show"), k("taxes", "set"), k("spreadsheets", "list"), k("spreadsheets", "share", "1")]).toEqual(["read", "write", "read", "write"]);
    for (const w of ["cat", "exclude", "split", "refund-mark", "config", "import", "export", "sync", "categorize", "research", "cash"]) {
      expect({ w, k: k(w, "1", "x") }).toEqual({ w, k: "refused" });
    }
    for (const r of ["brief", "overview", "txns", "burn", "sep", "trips", "points-vs-cash", "holdings", "changes"]) expect(k(r)).toBe("read");
    expect(READ_DENY.has("sql")).toBe(true);
  });

  test("unknown commands, bad flags and injection attempts are refused", () => {
    const bad = [
      inv("nope"), inv("txns", ["coffee; rm -rf /"]), inv("txns", ["--sql"]), inv("txns", ["-x"]), inv("txns", ["a|b"]),
      inv("txns", ["$(id)"]), inv("txns", ["`id`"]), inv("txns", ["a\nb"]), inv("txns", [], { month: "--json" }),
      inv("txns", [], { month: "2026-01;ls" }), inv("txns", [], { bogus: "1" }), inv("plan", ["set"], { file: "/etc/passwd" }),
      inv("export", [], { out: "x.xlsx" }), inv("txns", [], { json: true }), inv("txns", ["x".repeat(201)]),
      inv("txns", Array.from({ length: 9 }, () => "a")),
    ];
    for (const b of bad) expect(() => resolveInvocation(catalog, b)).toThrow();
    expect(resolveInvocation(catalog, inv("tx", ["coffee shop"], { limit: "5", month: "2026-03" }))).toEqual({
      command: "txns", argv: ["coffee shop", "--limit=5", "--month=2026-03"], classification: { kind: "read" },
    });
  });
});

describe("get_fin", () => {
  test("runs a read command against this database and returns its JSON", async () => {
    const out = await run("get_fin", { command: "txns", args: ["Market"], flags: { limit: 5 } });
    expect(JSON.stringify(out)).toContain("Market");
    const sep = await run("get_fin", { command: "sep", args: ["2026"] });
    expect(sep).toHaveProperty("sep");
  }, SLOW);

  test("refuses writes, SQL, network commands and unknown commands", async () => {
    const n = await bizCount();
    expect((await run("get_fin", { command: "business", args: ["add", "Desk"], flags: { amount: "5" } })).error).toMatch(/propose_fin_write/);
    expect((await run("get_fin", { command: "sql", args: ["select 1"] })).error).toMatch(/not available/);
    expect((await run("get_fin", { command: "sync" })).error).toMatch(/network/);
    expect((await run("get_fin", { command: "nope" })).error).toMatch(/Unknown command/);
    expect((await run("get_fin", { command: "txns", args: ["a; rm -rf ~"] })).error).toMatch(/not allowed/);
    expect(await bizCount()).toBe(n);
  }, SLOW);
});

describe("propose_fin_write", () => {
  test("business add: dry-run proposal writes nothing; apply writes, backs up and audits; undo removes it", async () => {
    const proposals: Change[] = [];
    const out = await run("propose_fin_write", { command: "business", args: ["add", "Standing desk"], flags: { amount: "249.99", year: "2026", category: "furniture" }, description: "Log the desk" }, proposals);
    expect(out).toMatchObject({ proposed: true });
    expect(await desks()).toHaveLength(0);
    const change = proposals[0];
    expect(change).toMatchObject({ kind: "cli", status: "proposed", txn: { id: 0 } });
    expect(change.summary).toContain('fin business add "Standing desk" --amount=249.99 --year=2026 --category=furniture');
    expect(change.after).toMatchObject({ undoable: true });

    const known = new Set(backups());
    const applied = await applyChange(change.id);
    expect(applied.status).toBe("applied");
    const rows = await desks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item: "Standing desk", amountCents: 24999, taxYear: 2026, category: "furniture" });
    expect(backups().some((f) => !known.has(f))).toBe(true);
    const audit = await db.select().from(ledgerChanges).where(eq(ledgerChanges.id, change.id)).get();
    expect(audit).toMatchObject({ status: "applied", origin: "assistant" });
    expect(JSON.parse(audit!.afterJson)).toMatchObject({ rowId: rows[0].id, result: { ok: true, id: rows[0].id } });
    expect((await listChanges(change.txn.date.slice(0, 7))).some((c) => c.id === change.id)).toBe(true);
    expect((await applyChange(change.id).catch((e) => e)).code).toBe("state");

    const undone = await undoChange(change.id);
    expect(undone.status).toBe("undone");
    expect(await desks()).toHaveLength(0);
  }, SLOW);

  test("points set: undo restores the previous balance, and a stale record refuses to apply", async () => {
    await db.insert(loyaltyPrograms).values({ name: "Zzyzx Rewards", kind: "hotel", balance: 1000 });
    const p = (await run("propose_fin_write", { command: "points", args: ["set", "zzyzx", "2500"] }));
    expect(p).toMatchObject({ proposed: true });
    const c = await applyChange(p.change_id);
    expect(c.status).toBe("applied");
    expect(await zzyzx()).toEqual([2500]);
    await undoChange(c.id);
    expect(await zzyzx()).toEqual([1000]);

    const q = await run("propose_fin_write", { command: "points", args: ["set", "zzyzx", "3000"] });
    await db.update(loyaltyPrograms).set({ balance: 1200 }).where(eq(loyaltyPrograms.name, "Zzyzx Rewards"));
    expect((await applyChange(q.change_id).catch((e) => e)).code).toBe("stale");
    expect(await zzyzx()).toEqual([1200]);
    await discardChange(q.change_id);
  }, SLOW);

  test("refuses what the CLI would refuse, reads, ledger edits and denied commands, writing nothing", async () => {
    const before = (await db.select().from(ledgerChanges)).length;
    const n = await bizCount();
    const bad: unknown[] = [
      { command: "business", args: ["add", "Desk"] }, // no --amount: the dry run fails
      { command: "business", args: ["2026"] },
      { command: "cat", args: ["1", "Groceries"] },
      { command: "plan", args: ["set"], flags: { file: "/tmp/x.json" } },
      { command: "spreadsheets", args: ["remove", "1"] },
      { command: "points", args: ["set", "x;y", "1"] },
    ];
    for (const b of bad) expect(await run("propose_fin_write", b)).toHaveProperty("error");
    expect((await db.select().from(ledgerChanges)).length).toBe(before);
    expect(await bizCount()).toBe(n);
  }, SLOW);
});

describe("wider writes and the activity log", () => {
  const planRow = async () => (await db.select().from(appConfig).where(eq(appConfig.key, "financial_planning_v1")).get())?.value ?? null;

  test("plan set takes a JSON body: dry run writes nothing, apply saves it, undo restores the old plan", async () => {
    const prior = await planRow();
    const proposals: Change[] = [];
    const out = await run("propose_fin_write", { command: "plan", args: ["set"], body: { monthlyEssentials: 1234, goalName: "Car" }, description: "Set essentials" }, proposals);
    expect(out).toMatchObject({ proposed: true });
    expect(await planRow()).toBe(prior);
    expect(proposals[0].summary).toContain("fin plan set --file=<");
    const applied = await applyChange(proposals[0].id);
    expect(applied.status).toBe("applied");
    expect(JSON.parse((await planRow())!)).toMatchObject({ monthlyEssentials: 1234, goalName: "Car" });
    await undoChange(applied.id);
    expect(await planRow()).toBe(prior);
  }, SLOW);

  test("plan set refuses a path, a missing body, a bad body, and a stale plan", async () => {
    const before = (await db.select().from(ledgerChanges)).length;
    for (const b of [
      { command: "plan", args: ["set"], flags: { file: "/etc/passwd" } },
      { command: "plan", args: ["set"] },
      { command: "plan", args: ["set"], body: { bogus: 1 } },
      { command: "business", args: ["add", "Desk"], flags: { amount: "5" }, body: { a: 1 } },
      { command: "config", args: ["simplefin_access_url", "x"] },
    ]) expect(await run("propose_fin_write", b)).toHaveProperty("error");
    expect((await db.select().from(ledgerChanges)).length).toBe(before);

    const p = await run("propose_fin_write", { command: "taxes", args: ["set"], body: { filingStatus: "single" } });
    expect(p).toMatchObject({ proposed: true });
    await db.insert(appConfig).values({ key: "financial_planning_v1", value: "{}" }).onConflictDoUpdate({ target: appConfig.key, set: { value: "{}" } });
    expect((await applyChange(p.change_id).catch((e) => e)).code).toBe("stale");
    await discardChange(p.change_id);
    await db.delete(appConfig).where(eq(appConfig.key, "financial_planning_v1"));
  }, SLOW);

  test("note: proposed, applied, undone; every step is in the activity log with its fin command", async () => {
    const p = await run("propose_fin_write", { command: "note", args: ["Rent goes up in March"], flags: { kind: "todo" } });
    expect(p).toMatchObject({ proposed: true });
    const c = await applyChange(p.change_id);
    const body = async () => (await db.select().from(notes)).filter((n) => n.body === "Rent goes up in March");
    expect(await body()).toHaveLength(1);
    await undoChange(c.id);
    expect(await body()).toHaveLength(0);
    const d = await run("propose_fin_write", { command: "note", args: ["Discard me"] });
    await discardChange(d.change_id);

    const log = await listActivity();
    const noted = log.find((a) => a.id === c.id)!;
    expect(noted.command).toBe('fin note "Rent goes up in March" --kind=todo');
    expect(noted.events.map((e) => e.action)).toEqual(["proposed", "applied", "undone"]);
    const gone = log.find((a) => a.id === d.change_id)!;
    expect(gone.events.at(-1)).toMatchObject({ action: "discarded", detail: "user" });
    expect(log[0].at >= log.at(-1)!.at).toBe(true);
  }, SLOW);
});
