/**
 * Output helpers tuned for two readers at once: a person skimming a terminal,
 * and a language model paying by the token. That means aligned plain columns,
 * no box drawing, no colour, and no repeated labels — the header carries the
 * meaning so every row underneath can be bare numbers.
 */
export type Align = "l" | "r";
export type Col = { head: string; align?: Align };

export const money = (cents: number, showCents = true): string => {
  const v = cents / 100;
  const s = v.toLocaleString("en-US", {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
  return v < 0 ? `-$${s.slice(1)}` : `$${s}`;
};

export const signed = (cents: number): string => (cents > 0 ? `+${money(cents)}` : money(cents));
export const pct = (v: number, digits = 1): string => `${v.toFixed(digits)}%`;
export const dim = (s: string) => s;

/** Cut a cell so one runaway merchant name cannot blow up every column. */
export const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;

export function table(cols: Col[], rows: (string | number)[][]): string {
  if (!rows.length) return "  (nothing)";
  const cells = rows.map((r) => r.map((c) => String(c)));
  const widths = cols.map((c, i) =>
    Math.max(c.head.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, i: number) =>
    cols[i].align === "r" ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const line = (r: string[]) => "  " + r.map((c, i) => pad(c ?? "", i)).join("  ").trimEnd();
  return [line(cols.map((c) => c.head)), ...cells.map(line)].join("\n");
}

/** Two-column key/value block for summaries. */
export function kv(pairs: [string, string][]): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join("\n");
}

export function heading(text: string): string {
  return `\n${text}`;
}

/** Render a value as JSON when --json was passed, otherwise run the printer. */
export function emit(json: boolean, data: unknown, printer: () => string): void {
  console.log(json ? JSON.stringify(data, null, 2) : printer());
}

/**
 * The one sentence SQLite actually said.
 *
 * Drizzle's message is `Failed query: <the entire generated statement>` with
 * the driver error hung off `cause`, so the useful part — "no such column:
 * nosuchcol" — is the only part that never gets printed.
 */
export function sqliteReason(error: unknown): string | undefined {
  let node: unknown = error instanceof Error ? error.cause : undefined;
  let text: string | undefined;
  for (let depth = 0; node instanceof Error && depth < 4; depth++) {
    text = node.message;
    node = node.cause;
  }
  const cleaned = text?.replace(/^SQLITE_[A-Z]+:\s*/, "").replace(/^SQLite error:\s*/i, "").trim();
  return cleaned || undefined;
}

/**
 * Last line of defence for the error path: never let a generated SQL statement
 * and its bound parameters land in a caller's transcript.
 */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (!raw.startsWith("Failed query:")) return raw;
  const reason = sqliteReason(error);
  return reason ? `the database rejected that query: ${reason}` : "the database rejected that query";
}
