/**
 * A deliberately small argument parser. Adding a dependency for this would cost
 * more to install than the twenty lines it replaces, and the shapes the CLI
 * needs are all `--flag`, `--key value`, and positionals.
 *
 * The one rule worth stating: a flag never silently falls back to its default.
 * `--months` with nothing after it, `--limit -5`, `--limit 2.7` are all errors,
 * because each of them otherwise answers a different question than the caller
 * asked and looks exactly like a successful answer.
 */
export type Args = {
  _: string[];
  flags: Record<string, string | true>;
};

/**
 * Flags that stand alone. Every other flag must be given a value — that is
 * what lets `--months` with no value be an error rather than a default.
 */
export const BOOLEAN_FLAGS = new Set([
  "json", "help", "all", "explain", "undo", "pin", "open", "full", "force",
  "for-agent", "share-with-agent", "allow-remote", "include-private-context",
  "run", "with-context",
]);

export const isBooleanFlag = (key: string): boolean => BOOLEAN_FLAGS.has(key);

export function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > -1) {
      out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (isBooleanFlag(key)) { out.flags[key] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.flags[key] = next;
      i++;
    } else {
      // Recorded as `true` and rejected on read: the parser does not know
      // whether the command wanted a number, a month, or a word.
      out.flags[key] = true;
    }
  }
  return out;
}

export const str = (a: Args, k: string): string | undefined => {
  const v = a.flags[k];
  if (v === undefined) return undefined;
  if (v === true) {
    if (isBooleanFlag(k)) return undefined;
    throw new Error(`--${k} expects a value, and none was given`);
  }
  return v;
};

/** An inclusive range a numeric flag must fall inside. */
export type Range = { min?: number; max?: number };

/**
 * Every numeric flag declares its range here, so "how big may this be" has one
 * answer instead of one per call site.
 */
export const RANGE = {
  /** Row counts. Zero rows is not a request anyone means. */
  limit: { min: 1, max: 10_000 },
  months: { min: 1, max: 120 },
  days: { min: 1, max: 3_650 },
  /** Row ids from the ledger; they start at 1. */
  id: { min: 1 },
  /** Mirrors researchRequestSchema, which rejects anything outside it. */
  steps: { min: 2, max: 6 },
  /** Notes shown in `fin brief`; 0 is a legitimate "skip the context block". */
  notes: { min: 0, max: 100 },
} as const satisfies Record<string, Range>;

/** Validate a numeric flag value that has already been read off the command line. */
export function checkNumber(k: string, raw: string, range: Range = {}): number {
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(n)) throw new Error(`--${k} expects a number, got "${raw}"`);
  if (!Number.isInteger(n)) throw new Error(`--${k} expects a whole number, got "${raw}"`);
  const { min, max } = range;
  if (min !== undefined && max !== undefined && (n < min || n > max)) {
    throw new Error(`--${k} must be between ${min} and ${max}, got ${n}`);
  }
  if (min !== undefined && n < min) throw new Error(`--${k} must be at least ${min}, got ${n}`);
  if (max !== undefined && n > max) throw new Error(`--${k} must be at most ${max}, got ${n}`);
  return n;
}

export const num = (a: Args, k: string, range: Range = {}): number | undefined => {
  const raw = a.flags[k];
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error(`--${k} expects a number, and none was given`);
  return checkNumber(k, raw, range);
};

export const bool = (a: Args, k: string): boolean => a.flags[k] === true || a.flags[k] === "true";

/**
 * A flag whose value must come from a fixed set. Without this a typo like
 * `--by merchnat` silently answers a different question than the one asked,
 * which is the worst failure mode for a caller that cannot see the table.
 */
export function pick<T extends string>(a: Args, k: string, allowed: readonly T[]): T | undefined {
  const v = str(a, k);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${k} must be one of ${allowed.join(", ")}, got "${v}"`);
  return v as T;
}

/** YYYY-MM, defaulting to the current month in the machine's local calendar. */
export function month(value: string | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`expected a YYYY-MM month, got "${value}"`);
  return value;
}

/** YYYY-MM-DD. A due date the caller mistyped is worse than no reminder. */
export function isoDay(value: string, label = "date"): string {
  const v = value.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${value}"`);
  }
  return v;
}

/** A positional row id. Same rules as a numeric flag, different blame. */
export function rowId(raw: string | undefined, label: string): number {
  if (raw === undefined || raw.trim() === "") throw new Error(`${label} is required`);
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a whole number, got "${raw}"`);
  }
  return n;
}

/** Shift a YYYY-MM month by a whole number of months. */
export function shiftMonth(m: string, by: number): string {
  const [y, mm] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mm - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
