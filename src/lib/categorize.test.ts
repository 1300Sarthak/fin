import { describe, expect, test } from "bun:test";
import { parseJsonReply, planRows, type loadContext } from "./categorize";
import type { Cat, Row } from "./categorize-core";

const cats: Cat[] = [
  { id: 1, name: "Restaurants", kind: "expense", parentId: 3 },
  { id: 2, name: "Fast Food", kind: "expense", parentId: 3 },
  { id: 3, name: "Food & Dining", kind: "expense", parentId: null },
  { id: 4, name: "Paycheck", kind: "income", parentId: null },
];
const loaded: Awaited<ReturnType<typeof loadContext>> = {
  cats,
  examples: [],
  ctx: { byName: new Map(cats.map((c) => [c.name, c])), userRules: [], systemRules: [], incomeSources: [], precedents: new Map(), cache: new Map() },
};
const row = (id: number, merchantRaw: string): Row => ({
  id, merchantRaw, payeeNormalized: merchantRaw.toLowerCase(), memo: null, note: null, amountCents: -2000,
  postedAt: new Date(Date.UTC(2026, 9, 1)), accountType: "credit", isTransfer: false, isRecurring: false, counterpartType: null,
});

test("a fenced or chatty JSON reply is still read", () => {
  expect(parseJsonReply('Sure!\n```json\n{"results":[{"id":1,"category":"Fast Food","confidence":0.9}]}\n```')).toEqual({ results: [{ id: 1, category: "Fast Food", confidence: 0.9 }] });
  expect(() => parseJsonReply("I cannot help")).toThrow("without JSON");
});

describe("AI layer", () => {
  test("every valid answer is applied, low confidence included, and kept as metadata", async () => {
    const plan = await planRows([row(1, "Wingstop"), row(2, "Thai Basil")], loaded, {
      ask: async () => ({ results: [{ id: 1, category: "Fast Food", confidence: 0.95 }, { id: 2, category: "Restaurants", confidence: 0.3 }] }),
    });
    expect(plan.decided.get(1)).toMatchObject({ categoryId: 2, source: "ai", confidence: 0.95 });
    expect(plan.decided.get(2)).toMatchObject({ categoryId: 1, source: "ai", confidence: 0.3 });
  });

  test("an unknown category is asked again once, then left uncategorised", async () => {
    let calls = 0;
    const plan = await planRows([row(1, "Mercantile")], loaded, {
      ask: async () => { calls++; return { results: [{ id: 1, category: "Snacks", confidence: 0.9 }] }; },
    });
    expect(calls).toBe(2);
    expect(plan.decided.has(1)).toBe(false);
  });

  test("a parent pick is applied but scored below a leaf", async () => {
    const plan = await planRows([row(1, "Cafe")], loaded, { ask: async () => ({ results: [{ id: 1, category: "Food & Dining", confidence: 0.9 }] }) });
    expect(plan.decided.get(1)?.confidence).toBeCloseTo(0.8);
  });

  test("a provider failure is reported, not thrown", async () => {
    const plan = await planRows([row(1, "Wingstop")], loaded, { ask: async () => { throw new Error("All AI providers failed: nim:network"); } });
    expect(plan.aiError).toContain("nim:network");
    expect(plan.decided.size).toBe(0);
  });

  test("cancelling stops before the next batch and keeps what was filed", async () => {
    const ac = new AbortController();
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, `Shop ${i}`));
    const seen: number[] = [];
    const plan = await planRows(rows, loaded, {
      signal: ac.signal,
      ask: async (o) => {
        const ids = [...o.user.matchAll(/^(\d+)\./gm)].map((m) => Number(m[1]));
        ac.abort();
        return { results: ids.map((id) => ({ id, category: "Restaurants", confidence: 0.9 })) };
      },
      onBatch: async (picks) => { seen.push(...picks.keys()); },
    });
    expect(plan.stopped).toBe(true);
    expect(plan.decided.size).toBe(25);
    expect(seen).toHaveLength(25);
  });

  test("the prompt never carries a person's name", async () => {
    let sent = "";
    await planRows([{ ...row(1, "Zelle Transfer to Rohan Iyer"), accountType: "checking" }], loaded, {
      ask: async (o) => { sent = `${o.system} ${o.user}`; return { results: [] }; },
    });
    expect(sent).toContain("Zelle to a person");
    expect(sent).not.toContain("Rohan");
  });
});
