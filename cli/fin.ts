#!/usr/bin/env bun
/**
 * `fin` — the finance dashboard as a terminal tool.
 *
 * Every command prints a compact table by default and full JSON with --json,
 * so the same binary serves a human skimming a terminal and an agent reading
 * the output back into a conversation.
 *
 * The contract an agent can rely on: --json puts one JSON value on stdout and
 * nothing else, every failure goes to stderr with exit 1, and a flag the
 * command does not know is a failure rather than a silently different answer.
 */
import { parse, bool, type Args } from "./args";
import { errorMessage } from "./render";
import * as money from "./commands/money";
import * as plan from "./commands/plan";
import * as meta from "./commands/meta";
import * as edit from "./commands/edit";
import * as hold from "./commands/holdings";
import * as data from "./commands/planning-data";
import * as agent from "./commands/agent";

type Handler = (a: Args, json: boolean) => Promise<void>;
type Group = "start" | "read" | "ahead" | "plan" | "fix" | "ai" | "admin";
type Command = {
  run: Handler;
  help: string;
  group: Group;
  /** Flags beyond --json / --help. Anything else is rejected, not ignored. */
  flags?: string[];
  /**
   * Two independent questions, because conflating them told agents that
   * `brief` was inert when it rewrites today's snapshot every run.
   *
   * `network` — what leaves this machine. Unset means nothing does.
   * `writes`  — what changes on disk. Unset means the run only reads.
   */
  network?: string;
  writes?: string;
};

const NO_NETWORK = "none — nothing leaves this machine";
const NO_WRITES = "none — reads the local database only";
/** Verified by running each command against a copy of the database and diffing it. */
const SNAPSHOT_WRITE = "local database — refreshes today's balance snapshot so net worth is current";

const COMMANDS: Record<string, Command> = {
  brief: { group: "start", run: meta.brief, help: "session primer: balances, burn, and saved context [--months N] [--to YYYY-MM]", flags: ["months", "to", "notes"], writes: SNAPSHOT_WRITE },
  context: { group: "start", run: agent.context, help: "local aggregate snapshot and planning context, as one JSON object" },
  doctor: { group: "start", run: agent.doctor, help: "which keys and database are configured; contacts nothing" },

  overview: { group: "read", run: money.overview, help: "net worth, spendable cash, and this month's flow [YYYY-MM]", flags: ["month"], writes: SNAPSHOT_WRITE },
  accounts: { group: "read", run: money.accounts, help: "balances per account [--all to include zero balances]", flags: ["all"] },
  burn: { group: "read", run: money.burn, help: "what you truly earned, spent, and saved [FROM] [TO] [--explain] [--kind K]", flags: ["explain", "kind"] },
  spending: { group: "read", run: money.spending, help: "spending breakdown [YYYY-MM] [--by category|merchant|card] [--limit N]", flags: ["month", "by", "limit"] },
  txns: { group: "read", run: money.txns, help: "search transactions [TEXT] [--month M] [--account ID] [--type income|expense]", flags: ["search", "month", "account", "category", "type", "limit"] },
  earnings: { group: "read", run: money.earnings, help: "income sources for a month [YYYY-MM]", flags: ["month"] },
  investments: { group: "read", run: money.investments, help: "invested balances, contributions, and income" },
  holdings: { group: "read", run: hold.holdings, help: "what each investment account actually holds [--account ID] [--symbol NVDA]", flags: ["account", "symbol"] },
  transfers: { group: "read", run: money.transfers, help: "money moved between your own accounts [--limit N]", flags: ["limit"] },
  refunds: { group: "read", run: money.refunds, help: "refunds and what they reverse [--limit N]", flags: ["limit"] },
  trend: { group: "read", run: money.trend, help: "income vs spending by month [--months N]", flags: ["months"] },
  budgets: { group: "read", run: money.budgets, help: "budget limits against actuals [YYYY-MM]", flags: ["month"] },
  history: { group: "read", run: money.history, help: "net worth and savings per period [--period month|week] [--limit N]", flags: ["period", "limit"] },
  allowance: { group: "read", run: meta.allowance, help: "what you can spend per day for the rest of the month [--month YYYY-MM]", flags: ["month"] },
  cash: { group: "read", run: money.cash, help: 'physical cash: `fin cash`, `fin cash add 40 tips`, `fin cash set 500` [--limit N]', flags: ["limit"], network: "free text is parsed by an AI provider when one is configured; bare `fin cash` contacts nothing", writes: "local database — the cash balance and one row, when given an amount; bare `fin cash` only reads" },

  upcoming: { group: "ahead", run: plan.upcoming, help: "bills due and the balance forecast [--days N]", flags: ["days"] },
  recurring: { group: "ahead", run: plan.recurring, help: "recurring charges, their cadence, and trials ending" },
  reminders: { group: "ahead", run: plan.reminders, help: "cancellation reminders: `list`, `add NAME YYYY-MM-DD`, `done ID` [--all]", flags: ["all", "date", "note"], writes: "local database — with `add` or `done`; the bare list only reads" },
  goals: { group: "ahead", run: plan.goals, help: "goal progress, free cash flow, and debts" },
  anomalies: { group: "ahead", run: plan.anomalies, help: "unusual spending this month [--month YYYY-MM]", flags: ["month"] },

  plan: { group: "plan", run: data.planning, help: "financial plan [show|schema|set --file PROFILE.json] [--for-agent]", flags: ["file", "for-agent"], writes: "local database — with `set`; `show` and `schema` only read" },
  taxes: { group: "plan", run: data.taxes, help: "tax opportunities [show|schema|set --file TAX.json]", flags: ["file"], writes: "local database — with `set`; `show` and `schema` only read" },
  import: { group: "plan", run: data.importSpreadsheet, help: "read a planning spreadsheet PATH.csv|xlsx; imports no transactions [--share-with-agent]", flags: ["file", "share-with-agent"], writes: "local database — stores the parsed spreadsheet; no ledger transactions are created" },
  spreadsheets: { group: "plan", run: data.spreadsheets, help: "planning uploads [list|share ID|unshare ID|remove ID] [--for-agent]", flags: ["for-agent"], writes: "local database — with `share`, `unshare` or `remove`; `list` only reads" },
  export: { group: "plan", run: data.exportData, help: "export finance data to XLSX --out PATH.xlsx [--force]", flags: ["out", "force"], writes: "the file at --out; the database is only read" },

  cat: { group: "fix", run: edit.cat, help: 'fix a category and remember it: `fin cat 412 "Public Transit"`', writes: "local database — the row's category, plus a rule and cache entry so it sticks" },
  exclude: { group: "fix", run: edit.exclude, help: "drop a row from every total, keeping it visible: `fin exclude 410` [--undo]", flags: ["undo"], writes: "local database — the row's excluded flag" },
  "refund-mark": { group: "fix", run: edit.refund, help: "flag money-in as a refund: `fin refund-mark 400 --reverses 222` [--undo]", flags: ["reverses", "undo"], writes: "local database — the row's refund flag and what it reverses" },
  pending: { group: "fix", run: edit.pending, help: "pending holds, and which already settled twice [--days N]", flags: ["days"] },
  note: { group: "fix", run: meta.note, help: 'remember something: `fin note "…" --pin --kind fact|decision|todo|question`', flags: ["kind", "tag", "pin", "open", "limit"], writes: "local database — unless the verb is `list`" },

  research: { group: "ai", run: agent.research, help: "research QUESTION [--run] [--with-context] [--provider anthropic|openai|nim] [--steps 2-6]; also status|tools|schema", flags: ["run", "with-context", "provider", "steps"], network: "only with --run" },

  sync: { group: "admin", run: meta.sync, help: "pull fresh data from SimpleFIN [--full also re-detects and categorises]", flags: ["full"], network: "SimpleFIN, and an AI provider with --full", writes: "local database — accounts, balances and transactions" },
  categorize: { group: "admin", run: meta.categorize, help: "categorise uncategorised transactions [--limit N]", flags: ["limit"], network: "sends merchant text to an AI provider when one is configured", writes: "local database — the category on every row it can classify, and the merchant cache" },
  config: { group: "admin", run: meta.config, help: "read or write settings: `fin config` lists, `fin config KEY` reads one, `fin config KEY VALUE` writes", writes: "local database — only in the `KEY VALUE` form; reading writes nothing" },
  sql: { group: "admin", run: meta.query, help: 'read-only SQL escape hatch: `fin sql "select …"`' },
};

const GROUPS: [Group, string][] = [
  ["start", "Start here"],
  ["read", "What happened to the money"],
  ["ahead", "What is coming"],
  ["plan", "Planning inputs and files"],
  ["fix", "Correcting the ledger"],
  ["ai", "Research (asks an AI provider, and only with --run)"],
  ["admin", "Setup and escape hatches"],
];

const ALIASES: Record<string, string> = {
  agent: "research",
  planning: "plan",
  tx: "txns",
  positions: "holdings",
  stocks: "holdings",
  daily: "allowance",
  transactions: "txns",
  spend: "spending",
  net: "overview",
  log: "note",
  notes: "note",
  q: "sql",
};

const WORKFLOW = [
  "fin brief --json                                  the state of the money in ~300 tokens",
  "fin burn / spending / txns / holdings --json      follow whatever the brief raises",
  'fin research "…" --json                           preview: provider, limits, privacy; no network',
  'fin research "…" --run --with-context --json      the only step that sends the question out',
  'fin note "…" --pin                                so the next session starts knowing it',
];

const NETWORK_NOTE = [
  "Everything is local except `research --run`, `sync`, `categorize`, and `cash` given free",
  "text — those four call a provider. `fin doctor` checks configuration without contacting one.",
];

const WRITES_NOTE = [
  "Reporting commands only read, with two exceptions: `brief` and `overview` refresh today's",
  "balance snapshot. `fin <command> --help` states the network and the writes for that command.",
];

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const out = [
    "fin — personal finance from the terminal",
    "",
    "Usage: fin <command> [args] [--json]",
    "",
    "Driving this from an agent:",
    ...WORKFLOW.map((line) => `  ${line}`),
  ];
  for (const [group, title] of GROUPS) {
    out.push("", `${title}:`);
    for (const [name, c] of Object.entries(COMMANDS)) {
      if (c.group === group) out.push(`  ${name.padEnd(width)}  ${c.help}`);
    }
  }
  out.push(
    "",
    ...NETWORK_NOTE.map((line) => `  ${line}`),
    ...WRITES_NOTE.map((line) => `  ${line}`),
    "  --json prints one JSON value on stdout and nothing else; failures print to stderr and exit 1.",
    "  --help on any command lists the flags it accepts. Any [YYYY-MM] positional also accepts --month.",
  );
  return out.join("\n");
}

function commandHelp(key: string, c: Command): string {
  const flags = ["--json", "--help", ...(c.flags ?? []).map((f) => `--${f}`)];
  return [
    `fin ${key} — ${c.help}`,
    `  flags:   ${flags.join(" ")}`,
    `  network: ${c.network ?? NO_NETWORK}`,
    `  writes:  ${c.writes ?? NO_WRITES}`,
  ].join("\n");
}

/** One shape for both `fin help --json` and `fin <cmd> --help --json`. */
const describe = (c: Command) => ({
  flags: ["json", "help", ...(c.flags ?? [])],
  network: c.network ?? null,
  writes: c.writes ?? null,
});

/** The catch below runs before argv is parsed, so it re-detects --json itself. */
const wantsJson = process.argv.slice(2).some((a) => /^--json(=true)?$/.test(a));

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const doc = {
      name: "fin",
      usage: "fin <command> [args] [--json]",
      workflow: WORKFLOW,
      network: NETWORK_NOTE.join(" "),
      writes: WRITES_NOTE.join(" "),
      json: "--json prints one JSON value on stdout and nothing else; failures print a {ok:false,error:{message}} envelope to stderr and exit 1.",
      // `network` and `writes` are present on every command, null when the
      // answer is "nothing" — an absent key used to read as "unknown".
      commands: Object.fromEntries(
        Object.entries(COMMANDS).map(([key, c]) => [key, { help: c.help, group: c.group, ...describe(c) }]),
      ),
      aliases: ALIASES,
    };
    console.log(wantsJson ? JSON.stringify(doc, null, 2) : usage());
    return;
  }
  const key = ALIASES[name] ?? name;
  const command = COMMANDS[key];
  if (!command) {
    throw new Error(`Unknown command "${name}". Run fin help for available commands.`);
  }
  const args = parse(argv.slice(1));
  if (bool(args, "help")) {
    console.log(bool(args, "json") ? JSON.stringify({ command: key, help: command.help, ...describe(command) }) : commandHelp(key, command));
    return;
  }
  const accepted = new Set(["json", "help", ...(command.flags ?? [])]);
  for (const flag of Object.keys(args.flags)) {
    if (accepted.has(flag)) continue;
    const rest = (command.flags ?? []).map((f) => `--${f}`);
    throw new Error(`Unknown flag --${flag} for "${key}". ${rest.length ? `Accepts ${rest.join(", ")}, --json, --help.` : "It accepts only --json and --help."}`);
  }
  await command.run(args, bool(args, "json"));
}

try {
  await main();
  process.exit(0);
} catch (e) {
  const message = errorMessage(e);
  console.error(wantsJson ? JSON.stringify({ ok: false, error: { message } }) : `fin: ${message}`);
  process.exit(1);
}
