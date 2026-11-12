<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# The `fin` CLI

`bin/fin` is how this project is meant to be driven. It is the dashboard's whole
feature set as commands, sharing `src/lib/` with the web UI so the two cannot
disagree. Prefer it over reading `finance.db` directly or starting the dev
server: it applies the same rules the UI does, and it is cheaper to read.

Start any session about money with `fin brief` — balances, three months of burn,
and every fact previously worth writing down, in about 300 tokens. Then reach
for whatever the question needs. `fin help` groups every command by what it
answers; `fin <command> --help` lists that command's flags and whether it can
reach the network. `--json` on any command gives the structured form.

The contract: `--json` puts one JSON value on stdout and nothing else, failures
go to stderr and exit 1, and an unrecognised flag is a failure rather than a
silently different answer.

## Reading

    fin brief                          # run this first
    fin burn 2026-06 2026-08           # true earned / spent / saved
    fin burn --explain --kind income   # why any row landed in a bucket
    fin spending 2026-08 --by merchant
    fin holdings --symbol VTI          # positions, and what is idle in cash
    fin allowance                      # spend per day left; sums budget groups when set
    fin budgets 2026-11                # budget groups vs actuals and pace
    fin spending --period ytd --by month   # any range: --from D --to D
    fin txns amazon --limit 10
    fin txns --from 2026-10-01 --to 2026-10-31 --category Restaurants --kind expense
                                       # also --merchant, --account, --source; same filters as /transactions
    fin income --from 2026-01 --to 2026-06 --by month   # ranges; `income earnings` = Earnings tab
    fin take-home                      # 2026 after tax, from paychecks
    fin activity --symbol VTI          # investment buys/sells/dividends and their funding
    fin business 2026 / fin sep 2026   # Schedule C expenses, SEP room
    fin cards / fin card-for Restaurants   # which card earns most here
    fin points / fin points-vs-cash 104 9436 --program chase [--hotel wyndham]
    fin trips --upcoming
    fin pending                        # holds, and which already settled twice
    fin context --json                 # every aggregate at once, for an agent
    fin sql "select …"                 # read-only escape hatch

## Correcting

The ledger is wrong sometimes; fix it in place rather than working around it.

    fin cat 412 "Public Transit"       # also writes a rule, so it sticks
    fin exclude 410                    # keep the row, drop it from totals
    fin refund-mark 400 --reverses 222
    fin note "…" --pin                 # so it is never re-derived
    fin changes --all                  # every assistant proposal/apply/undo, with its command

Planning writes follow the same `verb` shape: `fin income log SRC --month M
--hours N`, `fin take-home set …`, `fin budgets set NAME AMOUNT --categories
"A,B"`, `fin business add "ITEM" --amount X`, `fin cards set NAME …`,
`fin points set NAME BALANCE`, `fin trips add --kind hotel …`, `fin trips import FILE.json [--dry-run]` (file stays outside the repo; additive and idempotent), `fin goals set "Max Roth IRA 2027" --target 7500 --kind roth_ira --year 2027`, `fin goals set "Student loan interest 2026" --progress 412.50`, `fin goals rm NAME`.

## Planning inputs, uploads, and export

These are the numbers you tell the app, not the ones it derives. They live
beside the ledger and never mix with it.

    fin plan                           # remaining, reserve gap, goal need
    fin plan schema                    # the JSON shape `set` accepts
    fin plan set --file PROFILE.json   # unknown fields are rejected, not dropped
    fin taxes                          # 2026 federal illustration + opportunities
    fin import budget.csv              # reads a planning sheet; imports no rows
    fin spreadsheets share ID          # per-file switch for research context
    fin export --out books.xlsx        # everything, minus credentials

## Research

`fin research QUESTION` is a preview: it prints the provider, the call and
token ceilings, and exactly what would be sent, and makes no request. `--run`
is the step that sends the question; `--with-context` additionally shares
dashboard aggregates, holdings, and the planning inputs and uploads whose
sharing switches are on. A run has a 4-minute wall clock; tool steps stop a
minute early so the last call can still summarise the evidence gathered
(the answer is then marked limited). `fin research tools` and `fin research schema`
describe the loop without invoking it. `fin doctor` reports which keys and
which database are configured, and contacts nothing.

## The assistant (/assistant) and the CLI are one tool table

The chat assistant reads and proposes writes only through `fin` commands,
loaded from `fin help --json` (`src/lib/assistant/cli-catalog.ts`), so a new
command reaches it with no assistant code. Whether a form reads or writes is
parsed from the command's `writes` text, and anything unclear fails closed:

- Word a write command's `writes` field like this, so chat can propose it:

      writes: "local database — with `set` or `rm`; the bare report only reads"

  Each backticked verb after "with" becomes a proposal the user approves; the
  "only reads" clause says which forms stay reads (`the bare report`,
  `` `show` and `schema` ``). A `writes` the parser cannot read is refused in
  chat, though the command still works in the shell.
- A command with `network` set is never run from chat. `sql`, `config`,
  `import` and `export` are deliberately excluded.
- Every applied proposal lands in `fin changes --all` with its exact command.

## Assistant privacy

Every byte the assistant sends a hosted model goes through one `Privacy`
instance (`src/lib/assistant/privacy.ts`); research runs use the same wrapper,
`privateComplete(complete, await loadPrivacy())`. Do not call a provider
around it.

- Account names and masks become `⟦acct:<id>⟧`, people (Zelle/Venmo
  counterparties, names in notes, the owner) `⟦person:N⟧`, emails, phones and
  confirmation codes `⟦ref:N⟧`. The model's answer is rehydrated locally; the
  token map is never stored or sent.
- Row lists keep ids, dates, amounts and a normalised merchant; memos, notes
  and raw descriptors never leave.
- `FIN_PRIVATE_NAMES` (comma separated, in `.env.local`) adds names the
  detector cannot know, e.g. family members.
- The chat's "What was sent" view shows the exact pseudonymised payload.

## Web sign-in

The web app is password-protected when `FIN_PASSWORD_HASH` is set; the CLI is
not affected. `fin auth status` reports what this shell's env enables, and
`fin auth revoke` signs out every web session.

- `FIN_PASSWORD_HASH` — output of `bun run scripts/hash-password.ts`. Unset
  means no sign-in, and then only loopback requests are served: `next dev`,
  or a production build started with the opt-out below.
- `FIN_SESSION_SECRET` — 32+ random characters; changing it signs everyone out.
- `FIN_COOKIE_SECURE` — `1` forces the Secure cookie flag (behind a TLS proxy
  that talks plain HTTP to the app), `0` forbids it; unset infers.
- `FIN_ALLOW_NO_AUTH=loopback` — lets a production build run without a
  password, still only for loopback requests.

## Which income number is right

Two are correct answers to different questions, and they will disagree:

- `fin trend`, `fin spending`, `fin earnings` — cash that landed in spendable
  accounts. The dashboard's view, and the right basis for budgeting.
- `fin burn` — everything earned, including pay direct-deposited into a
  brokerage. Some brokerages book a contribution as a *negative* row inside
  the IRA, so the naive read loses it. Use this for "how much did I actually make".

`fin burn --explain` prints how every row was classified and why. When a number
looks wrong, start there rather than guessing.

## Things that will bite you

- **Four commands leave the machine.** `research --run`, `sync`, `categorize`,
  and `cash` given free text all call a provider; `categorize` sends merchant
  strings, `cash` sends the sentence you typed, pseudonymised through the same Privacy layer as research (names, accounts, phones become tokens). Everything else is local.
- **Categorising changes totals.** A category whose kind is `transfer` flips the
  row's `isTransfer`, which removes it from income. Re-run `fin burn` after
  `fin categorize` and say so if the numbers moved.
- **Pending rows double-count.** A card hold and its settlement arrive as two
  rows. `fin pending` finds the pairs; `scripts/dedupe-reissued-transactions.ts`
  does *not* — it only repairs provider-reissued ids.
- **Net-worth deltas before `realFrom` are reconstructed**, and inherit the same
  sign quirk. The CLI refuses to quote them; do not work around that.
- **Test against the demo ledger,** never the owner's: `bun run demo:seed` once,
  then `DATABASE_URL=file:.data/demo.db bin/fin …`.

## Adding a command

Handlers live in `cli/commands/`, take `(args, json)`, and print through
`cli/render.ts`. Register it in `cli/fin.ts` with a group, a one-line help
string, and every flag it reads — a flag left off that list is rejected at the
door. Values from a fixed set go through `pick()` in `cli/args.ts` so a typo
fails instead of quietly answering a different question. Query logic belongs in
`src/lib/` so the UI and the CLI stay in sync; the CLI formats and nothing more.
