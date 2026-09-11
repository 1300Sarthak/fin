import { describe, expect, test } from "bun:test";
import { looksLikeSet, parseCashDate, parseCashText } from "./cash-core";

const JAN = new Date("2026-01-15T12:00:00Z");

describe("cash text parsing", () => {
  test("reads the three operations", () => {
    expect(parseCashText("spent 15 on lunch", JAN)).toMatchObject({ op: "subtract", amountCents: 1500, note: "lunch" });
    expect(parseCashText("add 40 tips", JAN)).toMatchObject({ op: "add", amountCents: 4000 });
    expect(parseCashText("set 200", JAN)).toMatchObject({ op: "set", amountCents: 20000 });
  });

  test("a bare number, a sign prefix, and a plain sentence all resolve", () => {
    expect(parseCashText("200", JAN).op).toBe("set");
    expect(parseCashText("-25 parking", JAN)).toMatchObject({ op: "subtract", amountCents: 2500 });
    expect(parseCashText("+30", JAN).op).toBe("add");
    expect(parseCashText("I have 350 in my wallet", JAN)).toMatchObject({ op: "set", amountCents: 35000 });
  });

  // The bug this guards: "set" used to be the fallback for anything unmatched,
  // so a typo carrying a stray number silently overwrote the running total.
  test("text it cannot read is refused, never treated as a set", () => {
    expect(() => parseCashText("wibble 7 wobble", JAN)).toThrow(/Could not read/);
    expect(() => parseCashText("qwerty 42 zxcvb", JAN)).toThrow(/Could not read/);
  });

  test("text with no amount is refused", () => {
    expect(() => parseCashText("asdf", JAN)).toThrow(/No amount found/);
    expect(() => parseCashText("", JAN)).toThrow(/No amount found/);
  });

  // The model answers `set 0` when it misreads a phrase, which would empty the
  // balance; `looksLikeSet` is what stops that reaching the ledger.
  test("only text that evidences a set is allowed to replace the balance", () => {
    expect(looksLikeSet("I have 350 in my wallet")).toBe(true);
    expect(looksLikeSet("set 200")).toBe(true);
    expect(looksLikeSet("200")).toBe(true);
    expect(looksLikeSet("my total is now 90")).toBe(true);
    expect(looksLikeSet("wibble 7 wobble")).toBe(false);
    expect(looksLikeSet("spent 15 on lunch")).toBe(false);
    expect(looksLikeSet("add 40 tips")).toBe(false);
  });

  test("cents survive the round trip", () => {
    expect(parseCashText("spent 12.34 on coffee", JAN).amountCents).toBe(1234);
  });
});

describe("cash date parsing", () => {
  test("relative words", () => {
    expect(parseCashDate("yesterday", JAN)).toBe("2026-01-14");
    expect(parseCashDate("today", JAN)).toBe("2026-01-15");
  });

  test("explicit forms", () => {
    expect(parseCashDate("on 2026-03-04", JAN)).toBe("2026-03-04");
    expect(parseCashDate("on 3/4", JAN)).toBe("2026-03-04");
    expect(parseCashDate("on 3/4/25", JAN)).toBe("2025-03-04");
  });

  test("no date mentioned", () => {
    expect(parseCashDate("lunch", JAN)).toBeUndefined();
  });
});
