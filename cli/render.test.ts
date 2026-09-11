import { describe, expect, test } from "bun:test";
import { clip, errorMessage, money, pct, signed, sqliteReason, table } from "./render";

describe("money formatting", () => {
  test("cents in, dollars out, sign in front of the symbol", () => {
    expect(money(123456)).toBe("$1,234.56");
    expect(money(-62500)).toBe("-$625.00");
    expect(money(123456, false)).toBe("$1,235");
    expect(signed(2500)).toBe("+$25.00");
    expect(signed(-2500)).toBe("-$25.00");
    expect(pct(51.85)).toBe("51.9%");
  });

  test("clip keeps a column from running away", () => {
    expect(clip("Neighborhood market", 10)).toBe("Neighborh…");
    expect(clip("short", 10)).toBe("short");
  });

  test("an empty table says so rather than printing a bare header", () => {
    expect(table([{ head: "ID" }], [])).toBe("  (nothing)");
  });
});

describe("database error messages", () => {
  // Drizzle's message is the entire generated statement plus its bound
  // parameters; the sentence SQLite actually said is two `cause` levels down.
  const drizzleError = () => {
    const sqlite = new Error("no such column: nosuchcol");
    const driver = new Error("SQLITE_ERROR: no such column: nosuchcol", { cause: sqlite });
    return new Error('Failed query: select "id", "accountId" from "transactions"\nparams: 1,1', { cause: driver });
  };

  test("sqliteReason digs out the driver sentence and drops the code prefix", () => {
    expect(sqliteReason(drizzleError())).toBe("no such column: nosuchcol");
    expect(sqliteReason(new Error("plain", { cause: new Error("SQLITE_READONLY: attempt to write a readonly database") })))
      .toBe("attempt to write a readonly database");
    expect(sqliteReason(new Error("no cause"))).toBeUndefined();
  });

  test("errorMessage never lets a generated statement reach the caller", () => {
    const message = errorMessage(drizzleError());
    expect(message).toBe("the database rejected that query: no such column: nosuchcol");
    expect(message).not.toContain("select");
    expect(message).not.toContain("params");
  });

  test("errorMessage leaves an ordinary message alone", () => {
    expect(errorMessage(new Error("--limit must be at least 1, got -5"))).toBe("--limit must be at least 1, got -5");
    expect(errorMessage("not an Error")).toBe("not an Error");
  });
});
