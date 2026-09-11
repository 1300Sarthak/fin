# Contributing

Thanks for looking. This is a personal-finance tool, so the bar for changes is
"does it keep the numbers honest", not "does it add a feature".

## Before you start

Open an issue first for anything larger than a bug fix. A change that alters
how a total is computed needs a rationale more than it needs code.

`AGENTS.md` is the working guide for this repo — read it before writing
anything. Two things in it bite newcomers:

- **This is Next.js 16.** Conventions differ from older versions. Read the
  relevant guide in `node_modules/next/dist/docs/` before writing app code.
- **Query logic belongs in `src/lib/`.** The web app and the `fin` CLI both
  call it, which is what keeps the two from drifting apart. A CLI handler
  formats output and nothing more.

## Getting set up

```bash
bun install
bun run db:migrate
bun run demo:seed     # a fictional household, so you never test on real data
bun run demo          # http://127.0.0.1:6768
```

Develop against the demo database. Never paste output from a real
`finance.db` into an issue, a pull request, or a commit.

## Before you open a pull request

```bash
bun test        # 119 tests across 18 files at the time of writing
bun run lint
bun run build
```

Add a test for anything that computes money. The existing suites in
`src/lib/*.test.ts` are the pattern: pure functions in a `-core.ts` module,
tested without a database.

Keep pull requests small — under about 400 lines of diff, comments and tests
included. Stack several branches rather than sending one large one.

## What to include

- A description that leads with a one-line summary of what changed and why.
- The output of the tests you ran.
- For anything visible in the browser, say which pages you actually loaded.
- Flag problems you noticed but did not fix, rather than fixing them
  silently in an unrelated diff.

## Scope

Good contributions: correctness fixes in `src/lib/`, new ingest adapters,
accessibility fixes, new `fin` commands that expose existing library
functions, documentation that corrects something wrong.

Out of scope: hosted or multi-user modes, anything that adds telemetry or
sends more data to a third party by default, and anything that puts a claim
in the UI the code cannot back up.

## Reporting a security issue

Do not open a public issue for a vulnerability that could expose someone's
financial data. Report it privately through GitHub's security advisory form
on this repository.

## License

Contributions are accepted under the MIT license in `LICENSE`.
