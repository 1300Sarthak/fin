import "server-only";
/**
 * The `fin` command table, read from `fin help --json` so a new CLI command
 * reaches the assistant and GET /api/fin without code changes here.
 *
 * Read or write is decided from each command's own `writes` / `network`
 * metadata and the verb (first positional) of the invocation:
 *   - no `writes` (or only the balance-snapshot refresh) and no `network`: read
 *   - `network` set: never runnable from here
 *   - `writes` naming verbs ("with `log`", "with `add` or `done`"): those verbs
 *     write; the rest read only when the text also says a read form exists
 *     ("the bare report only reads", "`show` and `schema` only read")
 *   - "unless the verb is `list`": that verb reads, every other form writes
 *     (verb = a management verb such as `done`, else `add`)
 *   - anything else that writes: refused, whatever the arguments
 * Every unclear case fails closed. Argument values are validated here too.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { runFin } from "./fin-exec";

export type CatalogCommand = { help: string; group: string; flags: string[]; network: string | null; writes: string | null };
export type Catalog = { commands: Record<string, CatalogCommand>; aliases: Record<string, string> };

/** The `writes` text of `brief` and `overview`: a refresh, not an edit, so they count as reads. */
const SNAPSHOT_WRITE = /^local database — refreshes today's balance snapshot/;
/** Reads that bypass the assistant's data minimisation. Still on the CLI, just not here. */
export const READ_DENY = new Set(["sql"]);
/**
 * Writes not proposable from chat: `import` and `export` take file paths, and
 * `config` holds the bank connection. `plan set` / `taxes set` are proposable
 * with a JSON body that cli-writes.ts puts in a private file itself.
 */
export const WRITE_DENY = new Set(["config", "import", "export"]);
/** Verbs that manage existing rows in an "unless the verb is" command; any other first word is the text of a new row. */
const MANAGE_VERBS = new Set(["done", "rm", "remove", "delete", "pin", "unpin"]);
/** Flags that read or write files, or change what leaves the machine. */
const FLAG_DENY = new Set(["json", "help", "file", "out", "force", "for-agent", "share-with-agent", "run", "with-context"]);

const VERB = /^[a-z][a-z-]{0,23}$/;
const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => VERB.test(t));

export type Verbs = { writeVerbs: string[]; readVerbs: string[]; bareReads: boolean; exceptReads: string[] };
export function verbsOf(writes: string): Verbs {
  const writeVerbs = [...writes.matchAll(/\bwith ((?:`[^`]+`(?:,\s*|\s+or\s+|\s+and\s+)?)+)/g)].flatMap((m) => ticks(m[1]));
  const readClauses = writes.split(";").filter((c) => /\bonly reads?\b/.test(c));
  const exceptReads = [...writes.matchAll(/\bunless the verb is ((?:`[^`]+`(?:,\s*|\s+or\s+)?)+)/g)].flatMap((m) => ticks(m[1]));
  return {
    writeVerbs: exceptReads.length ? ["add", ...MANAGE_VERBS] : writeVerbs,
    readVerbs: [...readClauses.flatMap(ticks).filter((v) => !writeVerbs.includes(v)), ...exceptReads],
    bareReads: readClauses.some((c) => /\bbare\b/.test(c)),
    exceptReads,
  };
}

export type Classification =
  | { kind: "read" }
  | { kind: "write"; verb: string }
  | { kind: "refused"; reason: string };

/** What `fin <command> <positionals…>` would do. `command` must already be resolved. */
export function classify(c: CatalogCommand, positionals: string[]): Classification {
  if (c.network) return { kind: "refused", reason: "it can contact a network provider" };
  if (!c.writes || SNAPSHOT_WRITE.test(c.writes)) return { kind: "read" };
  const { writeVerbs, readVerbs, bareReads, exceptReads } = verbsOf(c.writes);
  const verb = positionals[0];
  if (exceptReads.length) {
    if (verb !== undefined && exceptReads.includes(verb)) return { kind: "read" };
    return { kind: "write", verb: verb !== undefined && MANAGE_VERBS.has(verb) ? verb : "add" };
  }
  if (verb !== undefined && writeVerbs.includes(verb)) return { kind: "write", verb };
  if (verb !== undefined && readVerbs.includes(verb)) return { kind: "read" };
  if (writeVerbs.length && (bareReads || (verb === undefined && readVerbs.length))) return { kind: "read" };
  return { kind: "refused", reason: "this form writes and has no proposal path" };
}

/* --------------------------------- loading ---------------------------------- */

const cache = globalThis as unknown as { __finCatalog?: { mtimeMs: number; value: Promise<Catalog> } };

/** Cached until cli/fin.ts changes on disk, so an edited table is picked up on the next call. */
export function loadCatalog(): Promise<Catalog> {
  const mtimeMs = statSync(path.join(process.cwd(), "cli", "fin.ts")).mtimeMs;
  if (cache.__finCatalog?.mtimeMs === mtimeMs) return cache.__finCatalog.value;
  const value = runFin("help", []).then((r) => {
    if (!r.ok) throw new Error(`fin help failed: ${r.error}`);
    const doc = JSON.parse(r.stdout) as { commands: Record<string, Partial<CatalogCommand>>; aliases?: Record<string, string> };
    const commands: Record<string, CatalogCommand> = {};
    for (const [name, c] of Object.entries(doc.commands)) {
      commands[name] = { help: String(c.help ?? ""), group: String(c.group ?? ""), flags: (c.flags ?? []).filter((f) => !["json", "help"].includes(f)), network: c.network ?? null, writes: c.writes ?? null };
    }
    return { commands, aliases: doc.aliases ?? {} };
  });
  cache.__finCatalog = { mtimeMs, value };
  value.catch(() => { if (cache.__finCatalog?.value === value) cache.__finCatalog = undefined; });
  return value;
}

/* -------------------------------- validation -------------------------------- */

export class InvocationError extends Error {}

export type Invocation = { command: string; positionals: string[]; flags: Record<string, string | true> };
export type Resolved = { command: string; argv: string[]; classification: Classification };

export const MAX_POSITIONALS = 8;
export const MAX_FLAGS = 10;
const MAX_VALUE = 200;

/**
 * One value bound for argv. No shell is involved, but a leading `-` would be
 * parsed as a flag and shell metacharacters have no legitimate use here.
 */
export function checkValue(label: string, v: string): string {
  if (typeof v !== "string" || v.length < 1 || v.length > MAX_VALUE) throw new InvocationError(`${label}: expected 1-${MAX_VALUE} characters`);
  if (v.startsWith("-")) throw new InvocationError(`${label}: must not start with '-'`);
  if (/[\x00-\x1f\x7f]/.test(v)) throw new InvocationError(`${label}: control characters are not allowed`);
  if (/[;|`$<>\\]/.test(v)) throw new InvocationError(`${label}: characters ; | \` $ < > \\ are not allowed`);
  return v;
}

/** Validate against the catalog and build argv (without --json). Throws InvocationError. */
export function resolveInvocation(catalog: Catalog, inv: Invocation): Resolved {
  const name = catalog.aliases[inv.command] ?? inv.command;
  if (!Object.hasOwn(catalog.commands, name)) throw new InvocationError(`Unknown command "${inv.command}". Known: ${Object.keys(catalog.commands).join(", ")}`);
  const c = catalog.commands[name];
  if (inv.positionals.length > MAX_POSITIONALS) throw new InvocationError(`At most ${MAX_POSITIONALS} arguments`);
  const keys = Object.keys(inv.flags);
  if (keys.length > MAX_FLAGS) throw new InvocationError(`At most ${MAX_FLAGS} flags`);
  const positionals = inv.positionals.map((v, i) => checkValue(`argument ${i + 1}`, v));
  const flags: string[] = [];
  for (const k of keys) {
    if (FLAG_DENY.has(k) || !c.flags.includes(k)) throw new InvocationError(`"${name}" does not accept --${k}${c.flags.length ? `; it accepts ${c.flags.filter((f) => !FLAG_DENY.has(f)).map((f) => `--${f}`).join(", ")}` : ""}`);
    const v = inv.flags[k];
    // `--k=v` so a value can never be taken for the next flag or a positional.
    flags.push(v === true ? `--${k}` : `--${k}=${checkValue(`--${k}`, v)}`);
  }
  return { command: name, argv: [...positionals, ...flags], classification: classify(c, positionals) };
}

/** Compact listing for a tool description: `name [flags] — help`. */
export function describeCommands(catalog: Catalog, which: "read" | "write"): string {
  const lines: string[] = [];
  for (const [name, c] of Object.entries(catalog.commands)) {
    if (c.network) continue;
    const writes = !!c.writes && !SNAPSHOT_WRITE.test(c.writes);
    const verbs = c.writes ? verbsOf(c.writes) : null;
    const flags = c.flags.filter((f) => !FLAG_DENY.has(f)).map((f) => `--${f}`).join(" ");
    if (which === "read") {
      if (READ_DENY.has(name)) continue;
      if (writes && !verbs!.bareReads && !verbs!.readVerbs.length) continue;
    } else if (!writes || WRITE_DENY.has(name) || !verbs!.writeVerbs.length) continue;
    const verbList = verbs?.exceptReads.length ? `TEXT|${[...MANAGE_VERBS].join("|")} IDS` : verbs?.writeVerbs.join("|");
    const body = which === "write" && c.flags.includes("file") ? " {JSON in body, never --file}" : "";
    lines.push(`${name}${which === "write" ? ` (${verbList})${body}` : ""}${flags ? ` [${flags}]` : ""}: ${c.help}`);
  }
  return lines.join("\n");
}
