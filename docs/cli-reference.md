# `fin` — command reference

Every command prints a compact table by default and structured JSON with
`--json`. `fin help` prints this list from the source of truth
(`cli/fin.ts`); `fin help --json` returns it as a machine-readable map of
command name to help string, plus the alias table.

```
Usage: fin <command> [args] [--json]
```

The contract an agent can rely on: `--json` puts one JSON value on stdout and
nothing else, every failure goes to stderr with exit 1, and a flag the command
does not know is a failure rather than a silently different answer.

## Start here

| Command | What it does |
| --- | --- |
| `brief` | Session primer: balances, burn, and saved context. `[--months N] [--to YYYY-MM]` |
| `context` | Local aggregate snapshot and planning context, as one JSON object |
| `doctor` | Which keys and database are configured; contacts nothing |

## What happened to the money

| Command | What it does |
| --- | --- |
| `overview` | Net worth, spendable cash, and this month's flow. `[YYYY-MM]` |
| `accounts` | Balances per account. `[--all` to include zero balances`]` |
| `burn` | What you truly earned, spent, and saved. `[FROM] [TO] [--explain] [--kind K]` |
| `spending` | Spending breakdown. `[YYYY-MM] [--by category\|merchant\|card] [--limit N]` |
| `txns` | Search transactions. `[TEXT] [--month M] [--account ID] [--type income\|expense]` |
| `earnings` | Income sources for a month. `[YYYY-MM]` |
| `investments` | Invested balances, contributions, and income |
| `holdings` | What each investment account actually holds. `[--account ID] [--symbol NVDA]` |
| `transfers` | Money moved between your own accounts. `[--limit N]` |
| `refunds` | Refunds and what they reverse. `[--limit N]` |
| `trend` | Income vs spending by month. `[--months N]` |
| `budgets` | Budget limits against actuals. `[YYYY-MM]` |
| `history` | Net worth and savings per period. `[--period month\|week] [--limit N]` |
| `allowance` | What you can spend per day for the rest of the month. `[--month YYYY-MM]` |
| `cash` | Physical cash: `fin cash`, `fin cash add 40 tips`, `fin cash set 500`. `[--limit N]` |

## What is coming

| Command | What it does |
| --- | --- |
| `upcoming` | Bills due and the balance forecast. `[--days N]` |
| `recurring` | Recurring charges, their cadence, and trials ending |
| `reminders` | Cancellation reminders: `list`, `add NAME YYYY-MM-DD`, `done ID`. `[--all]` |
| `goals` | Goal progress, free cash flow, and debts |
| `anomalies` | Unusual spending this month. `[--month YYYY-MM]` |

## Planning inputs and files

| Command | What it does |
| --- | --- |
| `plan` | Financial plan. `[show\|schema\|set --file PROFILE.json] [--for-agent]` |
| `taxes` | Tax opportunities. `[show\|schema\|set --file TAX.json]` |
| `import` | Read a planning spreadsheet; imports no transactions. `PATH.csv\|xlsx [--share-with-agent]` |
| `spreadsheets` | Planning uploads. `[list\|share ID\|unshare ID\|remove ID] [--for-agent]` |
| `export` | Export finance data to XLSX. `--out PATH.xlsx [--force]` |

## Correcting the ledger

The ledger is wrong sometimes. Fix it in place rather than working around it.

| Command | What it does |
| --- | --- |
| `cat` | Fix a category and remember it: `fin cat 412 "Public Transit"` |
| `exclude` | Drop a row from every total, keeping it visible: `fin exclude 410 [--undo]` |
| `refund-mark` | Flag money-in as a refund: `fin refund-mark 400 --reverses 222 [--undo]` |
| `pending` | Pending holds, and which already settled twice. `[--days N]` |
| `note` | Remember something: `fin note "…" --pin --kind fact\|decision\|todo\|question` |

Categorising changes totals. A category whose kind is `transfer` flips the
row's transfer flag, which removes it from income — re-run `fin burn` after
`fin cat` if the number matters.

## Research

| Command | What it does |
| --- | --- |
| `research` | `research QUESTION [--run] [--with-context] [--provider anthropic\|openai\|nim] [--steps 2-6]`; also `status`, `tools`, `schema` |

Previews by default. `--run` is what makes it call a provider.

## Setup and escape hatches

| Command | What it does |
| --- | --- |
| `sync` | Pull fresh data from SimpleFIN. `[--full` also re-detects and categorises`]` |
| `categorize` | Categorise uncategorised transactions. `[--limit N]` |
| `config` | Read or write settings: `fin config KEY VALUE` |
| `sql` | Read-only SQL escape hatch: `fin sql "select …"`. One statement, must begin `SELECT` or `WITH`, and runs under `PRAGMA query_only` so it cannot write |

The `SELECT`/`WITH` check reads the leading keyword only. It stops the obvious
accident, but a statement beginning `WITH … INSERT/UPDATE/DELETE` is still
accepted and will write — so `sql` is not a read-only sandbox, and untrusted
SQL does not belong in it.

## What leaves the machine

Local unless stated. Only `research --run`, `sync`, `categorize` and
free-text `cash` make a network request. `fin doctor` reports configuration
without contacting anything. `brief` and `overview` refresh today's balance
snapshot in the local database; every other reporting command only reads.

## Aliases

`agent`→`research`, `planning`→`plan`, `tx`/`transactions`→`txns`,
`positions`/`stocks`→`holdings`, `daily`→`allowance`, `spend`→`spending`,
`net`→`overview`, `log`/`notes`→`note`, `q`→`sql`.

## Flags

Boolean flags (no value required): `--json`, `--help`, `--all`, `--explain`,
`--undo`, `--pin`, `--open`, `--full`, `--force`, `--for-agent`,
`--share-with-agent`, `--run`, `--with-context`. Everything else takes a
value, either as `--key value` or `--key=value`.

`--help` on any command lists the flags it accepts, and a flag the command
does not accept is rejected rather than ignored. Any `[YYYY-MM]` positional
also accepts `--month`. Month arguments default to the current month in the
machine's local calendar.

## The JSON contract

- `--json` works on every command and prints a single JSON document to stdout
  and nothing else.
- Money is integer **cents** in JSON, dollars in the table view. A field named
  `…Cents` is always cents.
- Failures print `{"ok":false,"error":{"message":"…"}}` to **stderr** and exit
  1. Nothing lands on stdout, so a caller can parse stdout unconditionally.
- `fin help --json` returns `{name, usage, workflow, network, json, commands,
  aliases}`, where each entry in `commands` is `{help, group, flags}`.
- `fin <command> --help --json` returns `{command, help, flags, network}` —
  `network` is `null` for a command that only reads the local database.
- `fin research schema --json` returns the JSON Schema for a research request;
  `fin research tools --json` returns the tool specs that would be offered.

## Which income number is right

Two are correct answers to different questions, and they will disagree.

- `trend`, `spending`, `earnings` — cash that landed in spendable accounts.
  The dashboard's view, and the right basis for budgeting.
- `burn` — everything earned, including pay direct-deposited into a brokerage.
  A provider that books a retirement contribution as a negative row inside the
  IRA loses that income under the naive read. Use this for "how much did I
  actually make".

`fin burn --explain` prints how every row was classified and why. When a
number looks wrong, start there rather than guessing.

## Installing `fin` on your PATH

`bin/fin` resolves its own symlinks, pins `DATABASE_URL` to the repo's
database, and passes the repo's `.env.local` to Bun, so it behaves the same
from any working directory:

```bash
ln -s "$PWD/bin/fin" ~/.local/bin/fin
fin brief
```
