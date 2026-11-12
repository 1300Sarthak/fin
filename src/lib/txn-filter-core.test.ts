import { describe, expect, test } from "bun:test";
import { parseTxnFilter, txnHref } from "./txn-filter-core";

describe("transaction filter URL", () => {
  test("reads every contract param and drops malformed ones", () => {
    expect(parseTxnFilter({ from: "2026-10-01", to: "2026-10-31", category: "Food & Dining", merchant: "amazon", account: "20", kind: "expense", source: "Acme", q: "ref" }))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", category: "Food & Dining", merchant: "amazon", account: 20, kind: "expense", source: "Acme", q: "ref", id: undefined });
    const bad = parseTxnFilter({ from: "2026-13-01", to: "oct", account: "-3", kind: "refund", id: "1.5" });
    expect([bad.from, bad.to, bad.account, bad.kind, bad.id]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
  test("round-trips through txnHref", () => {
    const f = { from: "2026-10-01", to: "2026-10-31", category: "Food & Dining", kind: "income" as const };
    const href = txnHref(f);
    expect(href).toBe("/transactions?from=2026-10-01&to=2026-10-31&category=Food+%26+Dining&kind=income");
    expect(parseTxnFilter(Object.fromEntries(new URL(href, "http://x").searchParams))).toMatchObject(f);
    expect(txnHref({})).toBe("/transactions");
  });
});
