import { describe, expect, test } from "bun:test";
import {
  bool,
  checkNumber,
  isBooleanFlag,
  isoDay,
  month,
  num,
  parse,
  pick,
  RANGE,
  rowId,
  shiftMonth,
  str,
  type Args,
} from "./args";

const argv = (line: string): Args => parse(line.split(" ").filter(Boolean));

describe("parse", () => {
  test("separates positionals from flags in both spellings", () => {
    expect(argv("2026-08 --by merchant --limit=5")).toEqual({
      _: ["2026-08"],
      flags: { by: "merchant", limit: "5" },
    });
  });

  test("a boolean flag never swallows the token after it", () => {
    // `fin note "…" --pin` must keep the body as a positional.
    expect(parse(["--pin", "the roth is funded from payroll"])).toEqual({
      _: ["the roth is funded from payroll"],
      flags: { pin: true },
    });
  });

  test("a negative value is a value, not the next flag", () => {
    expect(argv("--limit -5").flags).toEqual({ limit: "-5" });
  });

  test("a value-less non-boolean flag is recorded, not defaulted", () => {
    // The bug: `--months` used to parse as `true`, num() returned undefined,
    // and the command answered with its default as though nothing was wrong.
    expect(argv("--months").flags).toEqual({ months: true });
    expect(argv("--months --json").flags).toEqual({ months: true, json: true });
  });
});

describe("str", () => {
  test("reads a value, and is undefined when the flag is absent", () => {
    expect(str(argv("--kind fact"), "kind")).toBe("fact");
    expect(str(argv(""), "kind")).toBeUndefined();
  });

  test("refuses a non-boolean flag given no value", () => {
    expect(() => str(argv("--kind"), "kind")).toThrow(/--kind expects a value/);
  });

  test("a boolean flag read as a string is simply absent", () => {
    expect(str(argv("--json"), "json")).toBeUndefined();
  });

  test("an empty value is a value", () => {
    expect(str(argv("--tag="), "tag")).toBe("");
  });
});

describe("num", () => {
  test("reads whole numbers and leaves absent flags undefined", () => {
    expect(num(argv("--limit 5"), "limit", RANGE.limit)).toBe(5);
    expect(num(argv(""), "limit", RANGE.limit)).toBeUndefined();
  });

  test("a value-less numeric flag is an error, not the default", () => {
    expect(() => num(argv("--months"), "months", RANGE.months)).toThrow(/--months expects a number/);
  });

  test("rejects text and empty values", () => {
    expect(() => num(argv("--limit abc"), "limit", RANGE.limit)).toThrow(/expects a number, got "abc"/);
    expect(() => num(argv("--limit="), "limit", RANGE.limit)).toThrow(/expects a number/);
  });

  // A fraction reached the query builder and SQLite rejected it, which dumped
  // the whole generated statement into the caller's transcript.
  test("rejects a fractional count", () => {
    expect(() => num(argv("--limit 2.7"), "limit", RANGE.limit)).toThrow(/expects a whole number, got "2.7"/);
  });

  test("rejects values outside the declared range", () => {
    expect(() => num(argv("--limit -5"), "limit", RANGE.limit)).toThrow(/--limit must be between 1 and 10000, got -5/);
    expect(() => num(argv("--limit 0"), "limit", RANGE.limit)).toThrow(/must be between 1 and 10000, got 0/);
    expect(() => num(argv("--months -6"), "months", RANGE.months)).toThrow(/--months must be between 1 and 120, got -6/);
    expect(() => num(argv("--days -30"), "days", RANGE.days)).toThrow(/--days must be between 1 and 3650, got -30/);
    expect(() => num(argv("--account 0"), "account", RANGE.id)).toThrow(/--account must be at least 1, got 0/);
  });

  test("the range bounds themselves are accepted", () => {
    expect(num(argv("--limit 1"), "limit", RANGE.limit)).toBe(1);
    expect(num(argv("--limit 10000"), "limit", RANGE.limit)).toBe(10000);
    expect(num(argv("--notes 0"), "notes", RANGE.notes)).toBe(0);
  });

  test("with no range declared, only the shape is checked", () => {
    expect(num(argv("--anything -3"), "anything")).toBe(-3);
    expect(() => num(argv("--anything 1.5"), "anything")).toThrow(/whole number/);
  });
});

describe("checkNumber", () => {
  test("reports at-least and at-most separately from a two-sided range", () => {
    expect(() => checkNumber("steps", "9", RANGE.steps)).toThrow(/between 2 and 6, got 9/);
    expect(() => checkNumber("id", "0", { min: 1 })).toThrow(/at least 1, got 0/);
    expect(() => checkNumber("id", "99", { max: 10 })).toThrow(/at most 10, got 99/);
    expect(checkNumber("limit", " 7 ")).toBe(7);
  });

  test("every declared range is coherent", () => {
    for (const [name, range] of Object.entries(RANGE)) {
      const { min, max } = range as { min?: number; max?: number };
      if (min !== undefined && max !== undefined) expect(min, name).toBeLessThanOrEqual(max);
    }
  });
});

describe("bool", () => {
  test("true when present, false when absent or explicitly false", () => {
    expect(bool(argv("--json"), "json")).toBe(true);
    expect(bool(argv("--json=true"), "json")).toBe(true);
    expect(bool(argv(""), "json")).toBe(false);
    expect(bool(argv("--json=false"), "json")).toBe(false);
  });

  test("the boolean set is the one the parser uses", () => {
    expect(isBooleanFlag("json")).toBe(true);
    expect(isBooleanFlag("limit")).toBe(false);
  });
});

describe("pick", () => {
  test("accepts a member of the set and names the set otherwise", () => {
    expect(pick(argv("--by merchant"), "by", ["category", "merchant"] as const)).toBe("merchant");
    expect(pick(argv(""), "by", ["category", "merchant"] as const)).toBeUndefined();
    expect(() => pick(argv("--by merchnat"), "by", ["category", "merchant"] as const)).toThrow(
      /--by must be one of category, merchant, got "merchnat"/,
    );
  });

  test("a value-less choice flag is refused, not treated as unset", () => {
    expect(() => pick(argv("--by"), "by", ["category", "merchant"] as const)).toThrow(/--by expects a value/);
  });
});

describe("dates and ids", () => {
  test("month accepts YYYY-MM and refuses anything else", () => {
    expect(month("2026-08")).toBe("2026-08");
    expect(month(undefined)).toMatch(/^\d{4}-\d{2}$/);
    expect(() => month("2026-13")).toThrow(/expected a YYYY-MM month/);
    expect(() => month("august")).toThrow(/expected a YYYY-MM month/);
  });

  test("isoDay accepts YYYY-MM-DD and blames the field", () => {
    expect(isoDay("2026-10-01", "the due date")).toBe("2026-10-01");
    expect(() => isoDay("No date here", "the due date")).toThrow(/the due date must be YYYY-MM-DD/);
    expect(() => isoDay("2026-02-30x", "the due date")).toThrow(/must be YYYY-MM-DD/);
  });

  test("rowId takes positive whole numbers only", () => {
    expect(rowId("412", "a transaction id")).toBe(412);
    expect(() => rowId(undefined, "a transaction id")).toThrow(/a transaction id is required/);
    expect(() => rowId("nine", "a note id")).toThrow(/a note id must be a whole number, got "nine"/);
    expect(() => rowId("2.7", "a note id")).toThrow(/whole number/);
    expect(() => rowId("-1", "a note id")).toThrow(/whole number/);
  });

  test("shiftMonth crosses year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-09", -2)).toBe("2026-07");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
