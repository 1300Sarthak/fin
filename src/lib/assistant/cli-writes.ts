import "server-only";
/**
 * Proposals that run a `fin` write command: `income log`, `business add`,
 * `points set`, `note`, `cards set`, `plan set`, and any later CLI verb whose
 * `writes` metadata names it.
 *
 * Same contract as the ledger edits in changes.ts: proposing writes nothing but
 * a `ledger_changes` row (kind "cli", txnId 0) holding the exact command and
 * argv; Apply backs the database up, then runs that argv. Proposing first runs
 * the command against a throwaway copy of the database, so a command the CLI
 * would refuse is refused before the user ever sees it, and the preview shows
 * what it would write.
 *
 * Commands that read `--file` (`plan set`, `taxes set`) take a JSON `body`
 * instead: it is stored in the proposal and written to a private 0600 file in a
 * fresh 0700 directory only for the length of the dry run and of the apply.
 *
 * Undo exists for the verbs in UNDO below, which know the one row they touch;
 * any other verb is applied as not undoable and says so in `after.undoable`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appConfig, businessExpenses, incomeEntries, ledgerChanges, loyaltyPrograms, notes, type LedgerChange } from "@/db/schema";
import { PLANNING_PROFILE_KEY } from "@/lib/financial-planning";
import { backupDatabase, ChangeError, expireStale, toChanges, type Change } from "./changes";
import { loadCatalog, resolveInvocation, InvocationError, WRITE_DENY, type Invocation } from "./cli-catalog";
import { runFin } from "./fin-exec";

/** Not yet in schema.ts's `changeKind`; the column is plain text, so no migration is needed. */
export const CLI_KIND = "cli";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PREVIEW_CAP = 2000;
export const BODY_CAP = 20_000;

/**
 * What a verb writes, for undo. `row`: the one row it reports by id (`upsert`
 * may update an existing row, so its prior state is kept). `config`: one
 * app_config value, restored as it was.
 */
type RowUndo = { table: typeof incomeEntries | typeof businessExpenses | typeof loyaltyPrograms | typeof notes; mode: "insert" | "upsert"; id: (result: Json) => unknown };
type Undo = RowUndo | { config: string };
const UNDO: Record<string, Undo> = {
  "income log": { table: incomeEntries, mode: "insert", id: (r) => r.id },
  "business add": { table: businessExpenses, mode: "insert", id: (r) => r.id },
  "points set": { table: loyaltyPrograms, mode: "upsert", id: (r) => r.id },
  "note add": { table: notes, mode: "insert", id: (r) => r.id },
  "plan set": { config: PLANNING_PROFILE_KEY },
  "taxes set": { config: PLANNING_PROFILE_KEY },
};
const isRowUndo = (u: Undo | undefined): u is RowUndo => !!u && "table" in u;

export const displayCommand = (command: string, argv: string[]) => `fin ${command} ${argv.map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`.trim();
const parseOut = (stdout: string): Json => { try { return JSON.parse(stdout) as Json; } catch { return { output: stdout.slice(0, PREVIEW_CAP) }; } };
const capJson = (v: unknown) => { const s = JSON.stringify(v); return s.length <= PREVIEW_CAP ? v : { truncated: true, text: s.slice(0, PREVIEW_CAP) }; };

/** Row as plain JSON (dates as epoch ms) so it can be stored and compared byte for byte. */
async function readRow(u: RowUndo, id: number): Promise<Json | null> {
  const row = await db.select().from(u.table).where(eq(u.table.id, id)).get();
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.getTime() : v]));
}
const readConfig = async (key: string) => (await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, key)).get())?.value ?? null;
const revive = (row: Json) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "id").map(([k, v]) => [k, /At$/.test(k) && typeof v === "number" ? new Date(v) : v]));
const validId = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ChangeError("state", "The command ran but did not report which row it wrote.");
  return v;
};

/** `fn` gets `--file=<path>` for a private copy of `body`, deleted afterwards; no body, no flag. */
async function withBody<T>(body: Json | null, fn: (extra: string[]) => Promise<T>): Promise<T> {
  if (!body) return fn([]);
  const dir = mkdtempSync(join(tmpdir(), "fin-body-")); // mkdtemp creates it 0700
  try {
    const file = join(dir, "body.json");
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    return await fn([`--file=${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the argv against a VACUUM copy of the database; nothing real is touched. */
async function dryRun(command: string, argv: string[], body: Json | null): Promise<Json> {
  const dir = mkdtempSync(join(tmpdir(), "fin-dryrun-"));
  try {
    const file = join(dir, "copy.db");
    await db.run(sql.raw(`VACUUM INTO '${file.replace(/'/g, "''")}'`));
    const r = await withBody(body, (extra) => runFin(command, [...argv, ...extra], { databaseUrl: `file:${file}` }));
    if (!r.ok) throw new ChangeError("invalid", `fin refused it: ${r.error}`);
    return parseOut(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkBody(body: unknown): Json {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChangeError("invalid", "body must be a JSON object.");
  if (JSON.stringify(body).length > BODY_CAP) throw new ChangeError("invalid", `body must be under ${BODY_CAP} characters of JSON.`);
  return body as Json;
}

export async function proposeCliWrite(inv: Invocation, description?: string, origin: "assistant" | "cli" = "assistant", body?: unknown): Promise<Change> {
  let resolved, catalog;
  try { catalog = await loadCatalog(); resolved = resolveInvocation(catalog, inv); }
  catch (e) { throw new ChangeError("invalid", e instanceof InvocationError ? e.message : "The command could not be checked."); }
  const { command, argv, classification } = resolved;
  if (classification.kind !== "write") throw new ChangeError("invalid", classification.kind === "read" ? "That command only reads; run it with get_fin instead." : `fin ${command} cannot be proposed: ${classification.reason}.`);
  if (WRITE_DENY.has(command)) throw new ChangeError("invalid", `fin ${command} ${classification.verb} changes files or the bank connection; run it from the terminal instead.`);
  const takesFile = catalog.commands[command].flags.includes("file");
  if (body !== undefined && !takesFile) throw new ChangeError("invalid", `fin ${command} does not take a JSON body.`);
  if (body === undefined && takesFile && classification.verb === "set") throw new ChangeError("invalid", `fin ${command} set needs its JSON in body (see fin ${command} schema).`);
  const json = body === undefined ? null : checkBody(body);
  const preview = await dryRun(command, argv, json);
  const undo = UNDO[`${command} ${classification.verb}`];
  // An upsert must find the row exactly as it is now when Apply runs; so must a config value.
  const previewId = isRowUndo(undo) ? validId(undo.id(preview)) : null;
  const priorRow = isRowUndo(undo) && undo.mode === "upsert" ? await readRow(undo, previewId!) : null;
  const priorConfig = undo && "config" in undo ? await readConfig(undo.config) : null;
  const cmd = displayCommand(command, argv) + (json ? ` --file=<${JSON.stringify(json).length}-character JSON body>` : "");
  const note = (description ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  await expireStale();
  const [row] = await db.insert(ledgerChanges).values({
    kind: CLI_KIND, txnId: 0, origin,
    summary: `${note ? `${note} — ` : ""}runs \`${cmd}\`${undo ? "" : " (cannot be undone from the app)"}`,
    beforeJson: JSON.stringify({ command, verb: classification.verb, argv, body: json, previewId, priorRow, priorConfig }),
    afterJson: JSON.stringify({ command: cmd, undoable: !!undo, preview: capJson(preview) }),
  }).returning();
  return (await toChanges([row]))[0];
}

/** Called by applyChange inside its lock, after the status check. Returns the new `after`. */
export async function applyCli(c: LedgerChange, before: Json, after: Json): Promise<Json> {
  const undo: Undo | undefined = UNDO[`${before.command} ${before.verb}`];
  if (isRowUndo(undo) && undo.mode === "upsert") {
    const now = await readRow(undo, before.previewId);
    if (JSON.stringify(now) !== JSON.stringify(before.priorRow)) throw new ChangeError("stale", "That record changed after the proposal. Nothing was changed; ask the assistant to propose it again.");
  }
  if (undo && "config" in undo && (await readConfig(undo.config)) !== (before.priorConfig ?? null)) {
    throw new ChangeError("stale", "Those settings changed after the proposal. Nothing was changed; ask the assistant to propose it again.");
  }
  await backupDatabase();
  const r = await withBody(before.body ?? null, (extra) => runFin(before.command, [...before.argv, ...extra]));
  if (!r.ok) throw new ChangeError("state", `fin refused it: ${r.error}. Nothing was changed.`);
  const result = parseOut(r.stdout);
  const next: Json = { ...after, result: capJson(result), appliedSeq: Date.now() };
  if (isRowUndo(undo)) {
    const id = validId(undo.id(result));
    next.rowId = id;
    next.row = await readRow(undo, id);
    // An upsert that landed on a different row than previewed cannot be restored to `priorRow`.
    if (undo.mode === "upsert" && id !== before.previewId) next.undoable = false;
  } else if (undo) next.config = await readConfig(undo.config);
  // Unconditional: the command already ran, and discard shares applyChange's lock, so it cannot race this.
  await db.update(ledgerChanges).set({ status: "applied", appliedAt: new Date(), afterJson: JSON.stringify(next) }).where(eq(ledgerChanges.id, c.id));
  return next;
}

/** Called by undoChange inside its lock, after the status check. */
export async function undoCli(c: LedgerChange, before: Json, after: Json): Promise<void> {
  const undo: Undo | undefined = UNDO[`${before.command} ${before.verb}`];
  if (!undo || !after.undoable) throw new ChangeError("state", `This change cannot be undone from the app. Restore a backup or fix it with fin ${before.command}.`);
  if ("config" in undo) {
    if ((await readConfig(undo.config)) !== after.config) throw new ChangeError("stale", "Those settings were changed again after this change, so it cannot be undone safely.");
    await backupDatabase();
    if (before.priorConfig == null) await db.delete(appConfig).where(eq(appConfig.key, undo.config));
    else await db.update(appConfig).set({ value: before.priorConfig, updatedAt: new Date() }).where(eq(appConfig.key, undo.config));
  } else {
    if (!after.rowId) throw new ChangeError("state", `This change cannot be undone from the app. Restore a backup or fix it with fin ${before.command}.`);
    const now = await readRow(undo, after.rowId);
    if (JSON.stringify(now) !== JSON.stringify(after.row)) throw new ChangeError("stale", "That record was edited again after the change, so it cannot be undone safely.");
    await backupDatabase();
    if (undo.mode === "insert" || !before.priorRow) await db.delete(undo.table).where(eq(undo.table.id, after.rowId));
    else await db.update(undo.table).set(revive(before.priorRow) as never).where(eq(undo.table.id, after.rowId));
  }
  await db.update(ledgerChanges).set({ status: "undone", undoneAt: new Date() }).where(eq(ledgerChanges.id, c.id));
}
