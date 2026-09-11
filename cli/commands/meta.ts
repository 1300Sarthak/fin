/**
 * The session-context commands, plus maintenance.
 *
 * `brief` exists so a terminal conversation can start informed. It is budgeted:
 * a screen of numbers plus the notes that were worth writing down, and nothing
 * else. Anything longer defeats the purpose of not re-explaining context.
 */
import { bool, month, num, RANGE, rowId, shiftMonth, str, type Args } from "../args";
import { clip, emit, errorMessage, heading, kv, money, pct, sqliteReason, table } from "../render";
import { getBurnReport } from "@/lib/burn";
import { getNetWorthSummary } from "@/lib/networth";
import { netWorthLine } from "../netchange";
import { monthRange, getSpendingByCategory } from "@/lib/spending";
import { addNote, briefNotes, completeNotes, deleteNotes, isNoteKind, listNotes, setPinned, NOTE_KINDS, type NoteKind } from "@/lib/notes";
import { getAllConfig, setConfig } from "@/lib/config";
import { syncSimplefin } from "@/lib/ingest/sync";
import { categorizeUncategorized } from "@/lib/categorize";
import { autoDetectRefunds } from "@/lib/refunds";
import { detectTransfers } from "@/lib/transfers";
import { detectRecurring } from "@/lib/recurring";
import { db } from "@/db";
import { sql } from "drizzle-orm";

const today = () => new Date().toISOString().slice(0, 10);

export async function brief(a: Args, json: boolean) {
  const to = month(str(a, "to"));
  const back = num(a, "months", RANGE.months) ?? 3;
  const from = shiftMonth(to, -(back - 1));
  const [nw, report, cats, notes] = await Promise.all([
    getNetWorthSummary({ range: "1M" }),
    getBurnReport(from, to),
    getSpendingByCategory(monthRange(to)),
    briefNotes(num(a, "notes", RANGE.notes) ?? 6),
  ]);
  const t = report.total;
  // No months back means no ledger there, not a month that earned nothing.
  // `total` would otherwise read as a confident $0.00 for a window with no data.
  const hasFlow = report.months.length > 0;

  if (json) {
    return emit(true, {
      netWorth: nw,
      range: { from, to },
      hasFlowData: hasFlow,
      flow: report.months,
      total: hasFlow ? t : null,
      topCategories: cats.slice(0, 4),
      notes,
    }, () => "");
  }

  const flowLine: [string, string] = hasFlow
    ? [`Last ${report.months.length} months`, `earned ${money(t.earnedCents)} · net spent ${money(t.netSpendCents)} · burn ${pct(t.burnPct)}`]
    : [`Last ${back} months`, `no data — nothing recorded between ${from} and ${to}`];

  const out = [
    `finance — ${today()}`,
    "",
    kv([
      ["Net worth", netWorthLine(nw)],
      ["Spendable", `${money(nw.liquidMoney.liquidAssetsCents)}   card debt ${money(nw.liabilities)}`],
      flowLine,
    ]),
    ...(hasFlow
      ? [
          table(
            [{ head: "MONTH" }, { head: "EARNED", align: "r" }, { head: "NET SPENT", align: "r" }, { head: "SAVED", align: "r" }, { head: "BURN", align: "r" }],
            report.months.map((m) => [m.month, money(m.earnedCents), money(m.netSpendCents), money(m.savedCents), pct(m.burnPct)]),
          ),
          `  Top ${to}: ${cats.slice(0, 4).map((c) => `${c.name} ${money(c.spentCents, false)}`).join(" · ") || "nothing yet"}`,
        ]
      : []),
  ];

  if (notes.length) {
    out.push(
      heading("Context"),
      table(
        [{ head: "" }, { head: "ID", align: "r" }, { head: "KIND" }, { head: "NOTE" }],
        notes.map((n) => [n.pinned ? "*" : "", n.id, n.doneAt ? `${n.kind}✓` : n.kind, clip(n.body, 88)]),
      ),
    );
  } else {
    out.push(heading("Context"), '  (none yet — add one with: fin note "…" --pin)');
  }
  console.log(out.join("\n"));
}

/**
 * Ids for `note done|rm|pin|unpin`. Dropping unparseable tokens silently is
 * how `fin note pin nine` came to report success having changed nothing.
 */
function noteIds(verb: string, rest: string[]): number[] {
  if (!rest.length) throw new Error(`usage: fin note ${verb} <id> [id…]   (run fin note list for the ids)`);
  return rest.map((token) => rowId(token, "a note id"));
}

/** A count of 0 means the ids do not exist; that is a failure, not a result. */
function checkTouched(changed: number, ids: number[], verb: string): void {
  const asked = ids.map((i) => `#${i}`).join(", ");
  if (changed === 0) {
    throw new Error(`no note matched ${asked} — run fin note list for the ids that exist`);
  }
  if (changed < ids.length) {
    throw new Error(`${verb} ${changed} of ${ids.length} notes; the rest of ${asked} do not exist — run fin note list`);
  }
}

export async function note(a: Args, json: boolean) {
  const [verb, ...rest] = a._;

  if (verb === "list" || verb === "ls") {
    const kind = str(a, "kind");
    if (kind && !isNoteKind(kind)) throw new Error(`--kind must be one of ${NOTE_KINDS.join(", ")}`);
    const rows = await listNotes({
      kind: kind as NoteKind | undefined,
      tag: str(a, "tag"),
      openOnly: bool(a, "open"),
      limit: num(a, "limit", RANGE.limit) ?? 30,
    });
    return emit(json, rows, () =>
      table(
        [{ head: "" }, { head: "ID", align: "r" }, { head: "KIND" }, { head: "ADDED" }, { head: "NOTE" }, { head: "TAGS" }],
        rows.map((n) => [n.pinned ? "*" : "", n.id, n.doneAt ? `${n.kind}✓` : n.kind, n.createdAt.toISOString().slice(0, 10), clip(n.body, 70), n.tags]),
      ),
    );
  }
  if (verb === "done") {
    const ids = noteIds(verb, rest);
    const n = await completeNotes(ids);
    checkTouched(n, ids, "completed");
    return emit(json, { completed: n, ids }, () => `  completed ${n}`);
  }
  if (verb === "rm") {
    const ids = noteIds(verb, rest);
    const n = await deleteNotes(ids);
    checkTouched(n, ids, "deleted");
    return emit(json, { deleted: n, ids }, () => `  deleted ${n}`);
  }
  if (verb === "pin" || verb === "unpin") {
    const ids = noteIds(verb, rest);
    const n = await setPinned(ids, verb === "pin");
    checkTouched(n, ids, `${verb}ned`);
    return emit(json, { changed: n, ids }, () => `  ${verb}ned ${n}`);
  }

  const body = a._.join(" ");
  if (!body) throw new Error('nothing to save — try: fin note "the Roth is funded straight from payroll" --pin');
  const kind = str(a, "kind") ?? "fact";
  if (!isNoteKind(kind)) throw new Error(`--kind must be one of ${NOTE_KINDS.join(", ")}`);
  const id = await addNote({
    body,
    kind,
    tags: (str(a, "tag") ?? "").split(",").filter(Boolean),
    pinned: bool(a, "pin"),
  });
  emit(json, { id }, () => `  saved #${id}`);
}

export async function sync(a: Args, json: boolean) {
  const r = await syncSimplefin();
  const extra: Record<string, unknown> = {};
  if (bool(a, "full")) {
    extra.transfers = await detectTransfers();
    extra.refunds = (await autoDetectRefunds()).length;
    extra.recurring = await detectRecurring();
    extra.categorized = await categorizeUncategorized();
  }
  emit(json, { ...r, ...extra }, () =>
    [
      `  synced ${r.accounts} accounts — ${r.newTransactions} new, ${r.updatedTransactions} updated`,
      r.newAccounts ? `  + ${r.newAccounts} new account(s)` : "",
      r.errors.length ? `  provider errors: ${r.errors.join("; ")}` : "",
      bool(a, "full") ? `  post-processing: ${JSON.stringify(extra)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/**
 * `categorizeUncategorized` swallows a failed provider batch and returns
 * `{usedAI:true, byAI:0}`, which reads exactly like a successful run that had
 * nothing to do. Distinguish the three outcomes here instead.
 */
export async function categorize(a: Args, json: boolean) {
  const r = await categorizeUncategorized({ limit: num(a, "limit", RANGE.limit) });
  const categorized = r.byRule + r.byCache + r.byAI;
  // The provider was called and assigned nothing: either it failed (the
  // library retains no error) or it declined every row. Both need saying.
  const aiFailed = r.usedAI && r.byAI === 0 && r.uncategorized > 0;
  const detail = aiFailed
    ? "the AI provider was called and returned nothing — check connectivity and `fin doctor`, then retry"
    : r.note;

  if (r.total === 0) {
    return emit(json, { ...r, categorized, aiFailed: false }, () => "  nothing to do — no uncategorised transactions");
  }
  if (categorized === 0) {
    throw new Error(`categorised none of ${r.total} transactions; ${r.uncategorized} still uncategorised.${detail ? ` ${detail[0].toUpperCase()}${detail.slice(1)}` : ""}`);
  }
  emit(json, { ...r, categorized, aiFailed, ...(detail ? { note: detail } : {}) }, () =>
    [
      `  categorised ${categorized} of ${r.total} — ${r.byRule} by rule, ${r.byCache} by cache, ${r.byAI} by AI`,
      r.uncategorized ? `  ${r.uncategorized} still uncategorised` : "",
      detail ? `  ${detail}` : "",
    ].filter(Boolean).join("\n"),
  );
}

/** Credentials live in this table too; never print one, in either shape. */
const SECRETISH = /token|url|secret/i;

export async function config(a: Args, json: boolean) {
  const [key, value, ...extra] = a._;
  if (extra.length) {
    throw new Error(`fin config takes a key and one value; got ${a._.length} arguments. Quote a value that contains spaces.`);
  }
  const all = await getAllConfig();
  const known = Object.keys(all);
  // setConfig will happily store a key nothing reads, and the listing hides
  // it, so the write looks like it worked and changes nothing.
  if (key !== undefined && !(key in all)) {
    throw new Error(`Unknown setting "${key}" — known keys: ${known.join(", ")}`);
  }
  if (key !== undefined && value !== undefined) {
    await setConfig(key, value);
    return emit(json, { key, value }, () => `  ${key} = ${value}`);
  }
  if (key !== undefined) {
    if (SECRETISH.test(key)) {
      return emit(json, { key, value: null, hidden: true }, () => `  ${key} = (hidden — credentials are never printed)`);
    }
    const current = all[key as keyof typeof all];
    return emit(json, { key, value: current }, () => `  ${key} = ${current === "" ? "(unset)" : current}`);
  }
  const shown = Object.entries(all).filter(([k]) => !SECRETISH.test(k));
  emit(json, Object.fromEntries(shown), () =>
    table([{ head: "KEY" }, { head: "VALUE" }], shown.map(([k, v]) => [k, clip(String(v), 60)])),
  );
}

/**
 * Read-only escape hatch for questions the commands do not cover.
 *
 * The keyword check alone is not a guarantee — `WITH t AS (…) INSERT … SELECT`
 * starts with `with` and writes. `PRAGMA query_only` is what actually enforces
 * it, at the connection, so a statement the regex misses still cannot write.
 */
export async function query(a: Args, json: boolean) {
  const q = a._.join(" ").trim();
  if (!q) throw new Error('usage: fin sql "select ... from transactions limit 20"');
  if (/;\s*\S/.test(q)) throw new Error("one statement at a time");
  if (!/^\s*(select|with)\b/i.test(q)) throw new Error("only SELECT and WITH are allowed");
  await db.run(sql.raw("PRAGMA query_only = ON"));
  let rows: Record<string, unknown>[];
  try {
    rows = (await db.all(sql.raw(q))) as Record<string, unknown>[];
  } catch (error) {
    // Drizzle wraps the driver error, so the SQLITE_READONLY text is on `cause`.
    const text = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    if (/READONLY/i.test(text)) throw new Error("that statement writes to the database; fin sql only reads");
    // Everything else: SQLite's own sentence, not drizzle's dump of the
    // generated statement and its bound parameters.
    const reason = sqliteReason(error);
    throw new Error(reason ? `SQL error: ${reason}` : errorMessage(error));
  } finally {
    await db.run(sql.raw("PRAGMA query_only = OFF"));
  }
  if (json || !rows.length) return emit(json, rows, () => "  (no rows)");
  const cols = Object.keys(rows[0]);
  console.log(
    table(
      cols.map((c) => ({ head: c.toUpperCase() })),
      rows.map((r) => cols.map((c) => (r[c] === null ? "—" : clip(String(r[c]), 40)))),
    ),
  );
}

/**
 * `fin allowance` — the daily-spend figure the phone app opens on, in the
 * terminal. Set the budget with `fin config monthly_budget_cents 65000`.
 */
export async function allowance(a: Args, json: boolean) {
  const { getAllowance } = await import("@/lib/allowance");
  const r = await getAllowance(month(str(a, "month")));
  emit(json, r, () => {
    if (r.budgetCents == null) {
      return "No monthly budget set.\nSet one with: fin config monthly_budget_cents 65000";
    }
    const lines = [
      heading(`Allowance — ${r.monthKey}`),
      kv([
        ["Budget", money(r.budgetCents)],
        ["Spent", `${money(r.spentCents)}  (day ${r.daysElapsed} of ${r.daysInMonth})`],
        ["Committed bills", money(r.committedCents)],
        ["Free to spend", money(r.freeCents)],
        [
          "Per day",
          r.perDayCents == null
            ? "—"
            : `${money(r.perDayCents)}  over ${r.daysRemaining} days`,
        ],
        ["Current pace", `${money(r.paceCents)}/day → ${money(r.projectedCents)}`],
      ]),
    ];
    if (r.isOver) lines.push(`\nOver budget by ${money(r.spentCents - r.budgetCents)}.`);
    return lines.join("\n");
  });
}
