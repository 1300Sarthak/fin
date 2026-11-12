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
import * as inc from "./commands/income";
import * as biz from "./commands/business";
import * as travel from "./commands/travel";
import * as cardsCmd from "./commands/cards";
import * as authCmd from "./commands/auth";
import * as budgetsCmd from "./commands/budgets";
import * as attach from "./commands/attachments";
import { syncBackfill } from "./commands/backfill";

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
  spending: { group: "read", run: budgetsCmd.spending, help: "spending for a range: made / spent / net, burn rate, daily average, projected [YYYY-MM] [--period this-month|last-month|ytd|12m|all | --from D --to D] [--by category|merchant|card|month] [--limit N]", flags: ["month", "by", "limit", "period", "from", "to"] },
  txns: { group: "read", run: money.txns, help: "search transactions [TEXT] [--from D] [--to D] [--month M] [--category NAME|ID] [--merchant TEXT] [--account ID] [--kind income|expense|cashflow|transfer] [--source INCOME_SOURCE] [--limit N]; same filter as /transactions", flags: ["search", "month", "account", "category", "type", "limit", "from", "to", "merchant", "kind", "source"] },
  earnings: { group: "read", run: money.earnings, help: "income sources for a month [YYYY-MM]", flags: ["month"] },
  investments: { group: "read", run: money.investments, help: "invested balances, plus money in and out for a range, the figures /investments shows [--period this-month|last-month|ytd|12m|all | --from D --to D] (default ytd)", flags: ["period", "from", "to"] },
  holdings: { group: "read", run: hold.holdings, help: "what each investment account actually holds [--account ID] [--symbol NVDA]", flags: ["account", "symbol"] },
  transfers: { group: "read", run: money.transfers, help: "money moved between your own accounts [--limit N]", flags: ["limit"] },
  refunds: { group: "read", run: money.refunds, help: "refunds and what they reverse [--limit N]", flags: ["limit"] },
  trend: { group: "read", run: money.trend, help: "income vs spending by month [--months N]", flags: ["months"] },
  budgets: { group: "plan", run: budgetsCmd.budgets, help: "budget groups vs actuals, pace and per-day left [YYYY-MM] · set NAME AMOUNT --categories \"A,B\" | --catch-all · rm NAME", flags: ["month", "categories", "catch-all"], writes: "local database — with `set` or `rm`; the bare list only reads" },
  history: { group: "read", run: money.history, help: "net worth and savings per period [--period month|week] [--limit N]", flags: ["period", "limit"] },
  allowance: { group: "read", run: budgetsCmd.allowance, help: "what you can spend per day for the rest of the month; sums budget groups when set [--month YYYY-MM]", flags: ["month"] },
  cash: { group: "read", run: money.cash, help: 'physical cash: `fin cash`, `fin cash add 40 tips`, `fin cash set 500` [--limit N]', flags: ["limit"], network: "free text is parsed by an AI provider when one is configured; bare `fin cash` contacts nothing", writes: "local database — the cash balance and one row, when given an amount; bare `fin cash` only reads" },

  upcoming: { group: "ahead", run: plan.upcoming, help: "bills due and the balance forecast [--days N]", flags: ["days"] },
  recurring: { group: "ahead", run: plan.recurring, help: "recurring charges, their cadence, and trials ending" },
  reminders: { group: "ahead", run: plan.reminders, help: "cancellation reminders: `list`, `add NAME YYYY-MM-DD`, `done ID` [--all]", flags: ["all", "date", "note"], writes: "local database — with `add` or `done`; the bare list only reads" },
  goals: { group: "ahead", run: plan.goals, help: "goal progress by measure (balance, roth_ira/hsa contributions, k401 deferrals, manual) with tax year, deadline and sources, plus free cash flow and debts; `set NAME --target X [--kind roth_ira|hsa|k401|manual|balance] [--year Y] [--progress X|none] [--account ID|none]`; `rm NAME`", flags: ["target", "kind", "year", "progress", "account"], writes: "local database — with `set` or `rm`; the bare report only reads" },
  anomalies: { group: "ahead", run: plan.anomalies, help: "unusual spending this month [--month YYYY-MM]", flags: ["month"] },

  plan: { group: "plan", run: data.planning, help: "financial plan [show|schema|set --file PROFILE.json] [--for-agent]", flags: ["file", "for-agent"], writes: "local database — with `set`; `show` and `schema` only read" },
  income: { group: "read", run: inc.income, help: "pay per job: W-2 / self-employment / nontaxable, owed and unmatched deposits [YEAR] [--source NAME]; any range: `--from YYYY-MM[-DD] --to … [--by week|month|quarter|year] [--basis paid|work] [--source A,B,Other]`; `log SOURCE --month YYYY-MM --hours N [--amount X] [--paid YYYY-MM-DD] [--txn ID]`; `earnings [--from D] [--to D]` for the Earnings tab", flags: ["source", "month", "hours", "amount", "paid", "txn", "from", "to", "by", "basis"], writes: "local database — with `log`; the bare report only reads" },
  activity: { group: "read", run: hold.activity, help: "investment history: what was bought/sold/paid in, when, and with what money [--account ID] [--symbol X] [--kind buy|sell|dividend|interest|contribution|transfer-in|transfer-out|fee|other] [--from YYYY-MM[-DD]] [--to …] [--all] [--limit N]", flags: ["account", "symbol", "kind", "from", "to", "all", "limit"] },
  points: { group: "read", run: travel.points, help: "loyalty balances and estimated value; `fin points set NAME BALANCE [--kind card|airline|hotel|other] [--cpp 1.1]`", flags: ["kind", "cpp"], writes: "local database — with `set`; the bare list only reads" },
  trips: { group: "read", run: travel.trips, help: "booked and past trips, nights per program this year [--upcoming]; `fin trips add --kind flight|hotel|car|other --provider P --title T --start YYYY-MM-DD [--end D] [--cost X] [--program NAME] [--via V]`; `fin trips import FILE.json [--dry-run]` (loyalty programs and bookings from an email export; shape in src/lib/travel-import.ts)", flags: ["upcoming", "kind", "provider", "title", "start", "end", "cost", "program", "via", "dry-run"], writes: "local database — with `add` or `import`; the bare list only reads" },
  "points-vs-cash": { group: "plan", run: travel.pointsVsCashCmd, help: "should this booking use points? `fin points-vs-cash 104 9436 --program chase [--hotel wyndham [--direct PRICE] [--stays N]]`", flags: ["program", "hotel", "direct", "stays"] },
  business: { group: "plan", run: biz.business, help: 'Schedule C expenses and SEP room [YEAR]; `fin business add "ITEM" --amount 249.99|unknown [--date D] [--paid-with T] [--pct 0-100] [--category C] [--txn ID] [--note T] [--year Y]`', flags: ["year", "item", "amount", "date", "paid-with", "pct", "category", "txn", "note"], writes: "local database — one business expense with `add`; the bare report only reads" },
  sep: { group: "plan", run: biz.sep, help: "SEP IRA max, SE tax, and Solo 401(k) alternative [YEAR] [--w2-deferrals DOLLARS]", flags: ["year", "w2-deferrals"] },
  cards: { group: "read", run: cardsCmd.cards, help: 'credit cards, rates, fees, what to use each for; `fin cards set NAME [--base 3] [--rate dining=3,drugstores=3] [--fee 0] [--fx 3|unknown] [--account ID|none] [--issuer T] [--currency cash|"chase ur"] [--active yes|no] [--note T]`; `fin cards remove NAME`; `fin cards missed [--from YYYY-MM] [--to YYYY-MM]`', flags: ["base", "rate", "fee", "fx", "account", "issuer", "currency", "active", "note", "from", "to"], writes: "local database — with `set` or `remove`; the list and `missed` only read" },
  "card-for": { group: "plan", run: cardsCmd.cardFor, help: "which card for this purchase? `fin card-for Restaurants|MERCHANT [--abroad] [--amount 40] [--date YYYY-MM-DD]`", flags: ["abroad", "amount", "date"] },
  auth: { group: "admin", run: authCmd.auth, help: "web sign-in: `status` (this shell's env) or `revoke` to sign out every web session", writes: "local database — with `revoke` (bumps auth_session_generation); `status` only reads" },
  "take-home": { group: "plan", run: inc.takeHome, help: "2026 after tax: W-2 gross rebuilt from paychecks, federal/FICA/SE/CA tax, set-aside, where the money went [YEAR] [--w2-gross X]; `set [--salary X] [--full-time YYYY-MM-DD] [--k401 pretax|roth] [--k401-pct N] [--hsa-payroll yes|no] [--periods N] [--ca-allowances N] [--project yes|no] [--ytd-gross X --as-of YYYY-MM-DD] [--deferrals X] [--fed-withheld X] [--ca-withheld X] [--expected-se X]` (none clears)", flags: ["w2-gross","k401-pct","salary","full-time","periods","ca-allowances","k401","hsa-payroll","project","ytd-gross","as-of","deferrals","fed-withheld","ca-withheld","expected-se"], writes: "local database — with `set`; the bare report only reads" },
  attachments: { group: "plan", run: attach.attachments, help: "files attached in the assistant: [list|add PATH|remove ID]; CSV/XLSX also become planning uploads", writes: "local database and the attachments folder — with `add` or `remove`; `list` only reads" },
  taxes: { group: "plan", run: data.taxes, help: "tax opportunities [show|schema|set --file TAX.json]", flags: ["file"], writes: "local database — with `set`; `show` and `schema` only read" },
  import: { group: "plan", run: data.importSpreadsheet, help: "read a planning spreadsheet PATH.csv|xlsx; imports no transactions [--share-with-agent]", flags: ["file", "share-with-agent"], writes: "local database — stores the parsed spreadsheet; no ledger transactions are created" },
  spreadsheets: { group: "plan", run: data.spreadsheets, help: "planning uploads [list|share ID|unshare ID|remove ID] [--for-agent]", flags: ["for-agent"], writes: "local database — with `share`, `unshare` or `remove`; `list` only reads" },
  export: { group: "plan", run: data.exportData, help: "export finance data to XLSX --out PATH.xlsx [--force]; with --month YYYY-MM, one month with splits and the audit log", flags: ["out", "force", "month"], writes: "the file at --out; the database is only read" },

  cat: { group: "fix", run: edit.cat, help: 'fix a category and remember it: `fin cat 412 "Public Transit"`', writes: "local database — the row's category, plus a rule and cache entry so it sticks" },
  exclude: { group: "fix", run: edit.exclude, help: "drop a row from every total, keeping it visible: `fin exclude 410` [--undo]", flags: ["undo"], writes: "local database — the row's excluded flag" },
  "refund-mark": { group: "fix", run: edit.refund, help: "flag money-in as a refund: `fin refund-mark 400 --reverses 222` [--undo]", flags: ["reverses", "undo"], writes: "local database — the row's refund flag and what it reverses" },
  split: { group: "fix", run: edit.split, help: "count only your share of a shared purchase: `fin split 412 21.00` [--undo]", flags: ["undo"], writes: "local database — adds a split-reimbursement row, a ledger_changes audit row, and a backup under backups/" },
  changes: { group: "fix", run: edit.changes, help: "audit log of assistant and split edits [--month YYYY-MM]; every proposal/apply/undo/discard with the exact command: [--all [--limit N]]", flags: ["month", "all", "limit"] },
  pending: { group: "fix", run: edit.pending, help: "pending holds, and which already settled twice [--days N]", flags: ["days"] },
  note: { group: "fix", run: meta.note, help: 'remember something: `fin note "…" --pin --kind fact|decision|todo|question`', flags: ["kind", "tag", "pin", "open", "limit"], writes: "local database — unless the verb is `list`" },

  research: { group: "ai", run: agent.research, help: "research QUESTION [--run] [--with-context] [--provider anthropic|openai|nim] [--steps 2-6]; also status|tools|schema", flags: ["run", "with-context", "provider", "steps"], network: "only with --run" },

  sync: { group: "admin", run: (a, json) => (bool(a, "backfill") ? syncBackfill(a, json) : meta.sync(a, json)), help: "pull fresh data from SimpleFIN [--full also re-detects and categorises]; [--backfill --since D [--until D] [--max-requests N] [--dry-run]] walk older history 45 days per request", flags: ["full", "backfill", "since", "until", "max-requests", "dry-run"], network: "SimpleFIN, and an AI provider with --full", writes: "local database — accounts, balances and transactions" },
  categorize: { group: "admin", run: meta.categorize, help: "categorise uncategorised transactions [--limit N] [--dry-run] [--no-ai] [--log] [--recheck-transfers]", flags: ["limit", "dry-run", "no-ai", "log", "recheck-transfers"], network: "sends merchant text to an AI provider when one is configured (not with --no-ai, --log or --recheck-transfers)", writes: "local database — the category on every uncategorised row, the merchant cache and the run log; --dry-run and --log only read" },
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
