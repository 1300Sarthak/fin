/**
 * GET /api/fin/<cmd>?... — the read-only subset of the `fin` CLI over HTTP.
 *
 * Returns exactly what `fin <cmd> ... --json` prints. The command list is the
 * CLI's own (src/lib/assistant/cli-catalog.ts), so this and the assistant's
 * get_fin tool expose the same reads and a new read command needs no change
 * here. A command or verb that writes, reaches the network, or runs SQL is
 * refused; `brief` and `overview` do refresh today's balance snapshot, as they
 * do from the CLI.
 *
 * Commands listed in COMMANDS below keep their typed parameters (month, limit,
 * ...). Every other read takes positionals as repeated `arg` and flags by name,
 * each value checked by the catalog's validator.
 */
import { checkValue, classify, InvocationError, loadCatalog, READ_DENY, resolveInvocation, type Catalog } from "@/lib/assistant/cli-catalog";
import { runFin } from "@/lib/assistant/fin-exec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });

type Kind = "month" | "symbol" | "account" | "by" | "type" | "period" | "limit" | "months" | "days" | "all" | "q" | "ymd";
/** How a query param reaches the CLI: positional (in order) or --flag. */
type Spec = { param: string; kind: Kind; as: "pos" | "flag"; flag?: string };

const MONTH: Spec = { param: "month", kind: "month", as: "pos" };
const MONTH_FLAG: Spec = { param: "month", kind: "month", as: "flag", flag: "month" };
const LIMIT: Spec = { param: "limit", kind: "limit", as: "flag", flag: "limit" };

const COMMANDS: Record<string, Spec[]> = {
  brief: [{ param: "months", kind: "months", as: "flag", flag: "months" }],
  overview: [MONTH],
  accounts: [{ param: "all", kind: "all", as: "flag", flag: "all" }],
  holdings: [
    { param: "symbol", kind: "symbol", as: "flag", flag: "symbol" },
    { param: "account", kind: "account", as: "flag", flag: "account" },
  ],
  spending: [MONTH, { param: "by", kind: "by", as: "flag", flag: "by" }, LIMIT],
  burn: [
    { param: "from", kind: "month", as: "pos" },
    { param: "to", kind: "month", as: "pos" },
  ],
  txns: [
    { param: "q", kind: "q", as: "pos" },
    MONTH_FLAG,
    { param: "account", kind: "account", as: "flag", flag: "account" },
    { param: "type", kind: "type", as: "flag", flag: "type" },
    LIMIT,
  ],
  earnings: [MONTH],
  investments: [],
  trend: [{ param: "months", kind: "months", as: "flag", flag: "months" }],
  upcoming: [{ param: "days", kind: "days", as: "flag", flag: "days" }],
  recurring: [],
  goals: [],
  allowance: [MONTH_FLAG],
  history: [{ param: "period", kind: "period", as: "flag", flag: "period" }, LIMIT],
  budgets: [MONTH],
};

const ENUMS: Partial<Record<Kind, string[]>> = {
  by: ["category", "merchant", "card"],
  type: ["income", "expense"],
  period: ["month", "week"],
};
const INT_RANGE: Partial<Record<Kind, [number, number]>> = {
  limit: [1, 1000],
  months: [1, 120],
  days: [1, 365],
};

class BadInput extends Error {}

/** Returns the validated string, or throws BadInput. */
function validate(spec: Spec, v: string): string {
  const bad = (why: string) => new BadInput(`Invalid "${spec.param}": ${why}`);
  switch (spec.kind) {
    case "month": {
      const m = /^(\d{4})-(\d{2})$/.exec(v);
      if (!m || +m[2] < 1 || +m[2] > 12) throw bad("expected YYYY-MM");
      return v;
    }
    case "symbol":
      if (!/^[A-Za-z0-9][A-Za-z0-9.\-]{0,11}$/.test(v)) throw bad("expected a ticker like NVDA or BRK.B");
      return v;
    case "account":
      if (!/^[1-9]\d{0,8}$/.test(v)) throw bad("expected a numeric account id");
      return v;
    case "q":
      if (v.length < 1 || v.length > 80) throw bad("expected 1-80 characters");
      if (v.startsWith("-")) throw bad("must not start with '-'");
      if (/[\x00-\x1f\x7f]/.test(v)) throw bad("control characters not allowed");
      return v;
    case "all":
      if (v !== "1") throw bad("expected 1");
      return v;
    case "by":
    case "type":
    case "period": {
      const allowed = ENUMS[spec.kind]!;
      if (!allowed.includes(v)) throw bad(`expected one of ${allowed.join("|")}`);
      return v;
    }
    case "limit":
    case "months":
    case "days": {
      const [lo, hi] = INT_RANGE[spec.kind]!;
      if (!/^\d{1,5}$/.test(v) || +v < lo || +v > hi) throw bad(`expected integer ${lo}-${hi}`);
      return String(+v);
    }
    default:
      throw bad("unsupported");
  }
}

function buildArgs(specs: Spec[], params: URLSearchParams): { pos: string[]; flags: string[] } {
  const known = new Set(specs.map((s) => s.param));
  for (const key of new Set(params.keys())) {
    if (!known.has(key)) throw new BadInput(`Unknown parameter "${key}"`);
  }
  const pos: string[] = [];
  const flags: string[] = [];
  let gap = false; // a later positional without an earlier one would shift meaning
  for (const spec of specs) {
    const all = params.getAll(spec.param);
    if (all.length > 1) throw new BadInput(`Parameter "${spec.param}" given more than once`);
    if (all.length === 0) {
      if (spec.as === "pos") gap = true;
      continue;
    }
    const value = validate(spec, all[0]);
    if (spec.as === "pos") {
      if (gap) throw new BadInput(`"${spec.param}" requires the preceding parameter`);
      pos.push(value);
    } else if (spec.kind === "all") {
      flags.push(`--${spec.flag}`);
    } else {
      flags.push(`--${spec.flag}`, value);
    }
  }
  const [from, to] = [params.get("from"), params.get("to")];
  if (from && to && from > to) throw new BadInput(`"from" ${from} is after "to" ${to}`);
  return { pos, flags };
}

/** Commands without typed specs: `arg` (repeatable, in order) plus the command's own flags. */
function genericInvocation(params: URLSearchParams) {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    if (key === "arg") { positionals.push(...all); continue; }
    if (all.length > 1) throw new BadInput(`Parameter "${key}" given more than once`);
    flags[key] = all[0] === "" || all[0] === "1" || all[0] === "true" ? true : all[0];
  }
  return { positionals, flags };
}

/** Typed specs for the commands that have them; the catalog decides which commands exist and that they read. */
function buildArgsFor(catalog: Catalog, cmd: string, params: URLSearchParams): string[] {
  if (READ_DENY.has(cmd)) throw new BadInput(`"${cmd}" is not available over HTTP`);
  try {
    if (Object.hasOwn(COMMANDS, cmd)) {
      const { pos, flags } = buildArgs(COMMANDS[cmd], params);
      if (classify(catalog.commands[cmd], pos.map((v) => checkValue("argument", v))).kind !== "read") throw new BadInput(`"${cmd}" with these parameters does not only read`);
      return [...pos, ...flags];
    }
    const r = resolveInvocation(catalog, { command: cmd, ...genericInvocation(params) });
    if (r.classification.kind !== "read") throw new BadInput(`"${cmd}" with these parameters does not only read`);
    return r.argv;
  } catch (e) {
    if (e instanceof InvocationError) throw new BadInput(e.message);
    throw e;
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ cmd: string }> }) {
  const { cmd } = await ctx.params;
  const catalog = await loadCatalog().catch(() => null);
  if (!catalog) return json({ error: "internal error" }, 500);
  // Aliases are not resolved: one URL per command keeps the typed specs authoritative.
  if (!Object.hasOwn(catalog.commands, cmd)) return json({ error: `Unknown command "${cmd}"` }, 404);
  let args: string[];
  try {
    args = buildArgsFor(catalog, cmd, new URL(request.url).searchParams);
  } catch (e) {
    if (e instanceof BadInput) return json({ error: e.message }, 400);
    throw e;
  }
  const result = await runFin(cmd, args);
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result.stdout.trim());
}
