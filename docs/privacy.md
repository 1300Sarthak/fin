# Privacy and data flow

This app is local-first: one SQLite file on your disk, no account, no server
component, no telemetry of its own. This page states exactly what leaves the
machine, when, and what it contains — all of it verifiable in the source
files named alongside each claim.

## The short version

With no API keys configured, **nothing leaves your machine**. The dashboard,
the CLI, planning, taxes, spreadsheet import, and the XLSX export all run
against the local database with the network untouched.

Four things can send data out, and each is something you switch on:

| Trigger | Destination | Contains |
| --- | --- | --- |
| `fin sync` / **Sync now** | Your SimpleFIN Bridge access URL | A request for your data. Nothing of yours is uploaded. |
| Categorising an unknown merchant | Your first configured AI provider | Merchant string, memo, signed amount, your note, a row id |
| The natural-language cash box | Your first configured AI provider | The sentence you typed |
| A research run with `--run` | One AI provider you selected, plus Alpha Vantage / Exa if the model calls those tools | Your question; your aggregates only if you also passed `--with-context` |

## Never sent to an AI provider, under any configuration

- The SimpleFIN access URL, setup token, or any API key. Each key is sent only
  to the service it authenticates — the Alpha Vantage key to alphavantage.co,
  the Exa key to api.exa.ai — and to nothing else. `fin config` with no
  arguments even hides local config keys whose names match `token`, `url` or
  `secret` so they cannot end up in an agent transcript.
- Account names, account ids, or institution names. The research assistant's
  `dashboard_summary` tool is built to exclude them.
- Individual transaction rows, dates, or descriptions — except the merchant
  string, memo, amount and your own note during categorisation, described
  below.
- Balances, other than the aggregate figures listed under `dashboard_summary`
  and `planning_context`, and only with `--with-context`.
- Anything to Alpha Vantage or Exa beyond a ticker symbol, a dataset or topic
  name, and the API key for that service.

## Bank sync — SimpleFIN

`src/lib/ingest/simplefin.ts`, `src/lib/ingest/sync.ts`

SimpleFIN is a read-only protocol: an access URL with embedded credentials
that returns accounts, transactions and holdings. The app makes an outbound
HTTPS request to that URL and writes the response to the local database. It
sends nothing else. The bridge operator sees that you fetched, and already
holds the bank connection you gave it.

A setup token is single-use. On first sync the app claims it and caches the
resulting access URL in the local database so the claim is not wasted.

If you never set `SIMPLEFIN_ACCESS_URL`, no sync request is ever made. CSV
import and manual accounts are the offline path.

## AI categorisation

`src/lib/categorize.ts`

Categorisation runs a three-stage pipeline and the AI is the last stage:

1. **Rules** — 55 substring/regex rules ship with the seed, plus every rule
   your manual corrections created. Local.
2. **Merchant cache** — a normalised-merchant to category table, populated by
   every previous decision. Local.
3. **AI** — only the rows that missed both.

Stage 3 batches up to 40 transactions per request. Each transaction is one
line of the form:

```
412. NEIGHBORHOOD MARKET (memo if any) -$42.50 [user note: if any]
```

Alongside it goes a short system prompt and the list of allowed category
names. That is the entire payload: no dates, no account, no balance, no
institution, no identity. The row id is the local integer primary key.

Every AI answer is written back to the merchant cache, so a given merchant is
sent at most once. Correcting a category by hand writes a rule as well, which
means corrections are never re-asked either.

With no provider key, stage 3 is skipped and the rows stay uncategorised —
the CLI says so and tells you which variable to set.

## The natural-language cash box

`src/lib/cash.ts`

`fin cash add 40 tips`, and the free-text box on the Cash page, send that
sentence to the configured provider to be parsed into an operation, an
amount, a note and a date. If no provider is configured — or if every
configured one fails — a deterministic regex parser handles it locally, and
the result is applied the same way. The text you type is the only thing sent.

## The research assistant

`src/lib/ai/research.ts`, `research-core.ts`, `research-tools.ts`

A research run is the one place the app deliberately sends financial context
outward, and it is gated twice.

**Gate one — `--run`.** Without it, `fin research` prints a preview and makes
no network request. The Research page requires the equivalent explicit
choice: the request schema has `allowRemote: z.literal(true)`, so a request
that does not carry consent fails validation before any provider is reached.

**Gate two — `--with-context`.** Off by default. With it off, the two local
tools are not created at all, and the system prompt tells the model that
local context access is disabled and it must not claim access to your
finances.

Unlike categorisation, a research run **never falls through to a second
vendor**. It uses the one provider you selected (or the first configured one)
and fails with a message if that provider is down.

### What each tool sends

| Tool | Requires | Leaves the machine | Payload |
| --- | --- | --- | --- |
| `stock_data` | `ALPHAVANTAGE_API_KEY` | Yes → alphavantage.co | A ticker symbol, a dataset name, your key |
| `search_public_finance` | `EXA_API_KEY` | Yes → api.exa.ai | A fixed query template built from a ticker, or the tax topic. Filings are restricted to `sec.gov`, tax topics to `irs.gov`. No free-form text and no amounts can reach it. |
| `dcf_scenario` | nothing | **No** | Runs locally on assumptions the model supplies |
| `planning_context` | `--with-context` **and** per-item sharing switches | Yes → the AI provider | Your saved plan/tax inputs and shared spreadsheet summaries, plus three liquidity totals (liquid assets, liabilities, the difference) |
| `dashboard_summary` | `--with-context` | Yes → the AI provider | Assets, liabilities and net worth as cents; three months of income/spending/saved; the burn report; up to 50 positions as symbol, shares, market value, cost basis, as-of date |

`planning_context` applies two independent switches: your saved financial and
tax profile is included only if you enabled sharing on it, and each uploaded
spreadsheet is included only if you enabled sharing on that file. A
disabled item is filtered out before the tool returns. The three liquidity
totals are the one part not behind those switches — they are aggregates
`dashboard_summary` would disclose anyway under the same `--with-context`
gate, and they carry no account name, id or per-account balance.

Note what `dashboard_summary` omits: no transaction descriptions, no account
names, no account identifiers, no institution. The model sees shapes and
totals, not a ledger.

### Handling of untrusted content

Spreadsheet cells, planning-profile text and tool results are treated as
data. The system prompt states this explicitly and instructs the model to
ignore instructions embedded in them, including requests to reveal secrets or
contact other services. Source URLs are filtered through `safeSourceUrl`,
which accepts only `https`, rejects embedded credentials, and rejects
localhost plus the common private-network ranges.

## Spreadsheet uploads

`src/lib/spreadsheets.ts`, `src/lib/spreadsheet-core.ts`

CSV and XLSX files are parsed locally and stored as a summary in your own
database. Upload alone shares nothing: a file reaches an AI provider only if
you turn on sharing for it *and* run research with `--with-context`. Limits:
5 MB per file, 10 files kept.

## Export

`fin export --out file.xlsx`, and the download button in Settings, build the
workbook locally and hand it to you. It is not uploaded anywhere. It does
contain your real figures, so treat the file the way you would a bank
statement.

## What the repository will not leak

`.gitignore` excludes `finance.db` and every `*.db`, `.env*`, `*.csv`,
`*.xlsx`, `.data/`, `uploads/` and `exports/`. Three deliberate exceptions are
re-included because they are documentation, not data: `.env.example` (every
value blank), `examples/*.csv`, and the eleven allow-listed screenshots under
`docs/screenshots/`, all of which show the synthetic demo household. The demo
database itself lives in `.data/`, which is ignored.

## Framework telemetry

Next.js collects anonymous usage telemetry by default. That is the framework,
not this app, and it carries no financial data — but if you want it off:

```bash
bunx next telemetry --disable
```

## Deployment

This is a single-owner app with no authentication. Keep it on `localhost` or
behind your own authenticated private network. Do not put it on a public
host.
