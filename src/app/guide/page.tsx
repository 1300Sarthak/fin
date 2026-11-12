import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Disclosure, PageHeader, Section } from "@/components/kit";
import { CopyCommand } from "@/components/copy-command";
// Every command on this page is exercised against the CLI; keep them in step
// with `cli/fin.ts` rather than paraphrasing what a command probably does.
const AGENT_BRIEF = `This repo has a \`fin\` CLI that answers questions about my money.
Run \`bin/fin help\` once, then use it instead of reading finance.db.

- Start every session with \`bin/fin brief --json\`.
- \`--json\` works on any command: one JSON value on stdout, nothing else.
- Failures print to stderr and exit 1. An unknown flag is a failure,
  never a silent default.
- \`bin/fin <command> --help\` lists the flags that command accepts.
- Everything runs locally except \`research --run\`, \`sync\`, \`categorize\`,
  and \`cash\` given free text. Those four call a provider.
- \`bin/fin research "question"\` only previews the cost and what would be
  sent. Add \`--run\` to ask the research assistant, and \`--with-context\`
  to include my aggregates.
- The ledger is wrong sometimes: fix it with \`bin/fin cat <id> "<category>"\`
  or \`bin/fin exclude <id>\` rather than working around it.
- Write down anything worth remembering: \`bin/fin note "…" --pin\`.`;
const placements = [
  { tool: "Claude Code", where: "CLAUDE.md or AGENTS.md in the repo root" },
  { tool: "Codex", where: "AGENTS.md in the repo root" },
  { tool: "Cursor", where: ".cursor/rules/fin.mdc" },
  { tool: "Anything else", where: "whatever file it reads at startup" },
];
const workflows = [
  { title: "Bring your own agent", detail: "Give a terminal agent the same facts you see here. Commands share the dashboard’s calculations, group themselves in `fin help`, and return structured JSON.", commands: ["bin/fin brief --json", "bin/fin burn 2026-06 2026-08 --json", "bin/fin context --json", "bin/fin help --json"] },
  { title: "Research with evidence", detail: "Investigate companies, compare scenarios, and use financial tools. Without --run you get a preview of the provider, the limits and the privacy terms — no request leaves the machine.", commands: ['bin/fin research "Compare VTI and a concentrated stock portfolio"', "bin/fin research tools --json", 'bin/fin research "Review my savings plan" --run --with-context --json'] },
  { title: "Plan with your spreadsheets", detail: "Read CSV and XLSX locally — no ledger transactions are imported. Choose sharing per file, then export a portable workbook.", commands: ["bin/fin import examples/monthly-budget.csv --json", "bin/fin spreadsheets list --json", "bin/fin plan --json", "bin/fin export --out finance-export.xlsx --json"] },
];
const guarantees = [
  ["One JSON value, one stream", "--json prints a single JSON value on stdout and nothing else, so the output pipes straight into a parser."],
  ["Failures are loud", "Every error prints to stderr and exits 1. With --json the error is a {\"ok\":false,\"error\":{\"message\"}} envelope, still on stderr."],
  ["No silent defaults", "An unknown flag, an unknown verb, or a value outside the allowed set stops the command and names what it accepts instead."],
  ["Local by default", "Only research --run, sync, categorize and free-text cash reach the network. bin/fin doctor reports your configuration without contacting anyone."],
];
/** The commands each page has a twin for; every line here runs as written against `bin/fin`. */
const commandGroups: { title: string; rows: [string, string][] }[] = [
  { title: "Transactions and spending", rows: [
    ["bin/fin txns --from 2026-10-01 --to 2026-10-31 --category Groceries", "the same filter as /transactions; also --merchant, --account ID, --kind income|expense|cashflow|transfer, --source NAME"],
    ["bin/fin spending 2026-10 --by merchant", "where the month went"],
    ["bin/fin budgets 2026-11", "budget limits against actuals"],
  ] },
  { title: "Income and investments", rows: [
    ["bin/fin income --from 2026-01 --to 2026-06 --by month", "pay per job over any range, grouped by week, month, quarter, or year"],
    ["bin/fin activity --from 2026-01 --kind buy", "what was bought, sold, or paid in, and with what money"],
  ] },
  { title: "Business and taxes", rows: [
    ['bin/fin business 2026', "Schedule C expenses and SEP room; `business add \"ITEM\" --amount X` to record one"],
    ["bin/fin sep 2026 --w2-deferrals 23500", "SEP IRA max, SE tax, and the Solo 401(k) alternative"],
  ] },
  { title: "Cards, points, and travel", rows: [
    ["bin/fin cards", "every card, its rates and fees, and what to use it for; `cards missed` for rewards left on the table"],
    ["bin/fin card-for Restaurants --amount 40", "which card for this purchase"],
    ["bin/fin points", "loyalty balances and what they are worth"],
    ["bin/fin trips --upcoming", "booked and past trips; `trips add --kind hotel --provider P --title T --start D` records one"],
    ["bin/fin points-vs-cash 104 9436 --program chase --hotel wyndham", "points in the portal vs cash in the portal vs booking direct, each net of what it earns"],
  ] },
];

export default function GuidePage() {
  return <>
    <PageHeader title="CLI & agent guide" description="The whole dashboard is also bin/fin, sharing these pages' calculations, so an agent driving it cannot disagree with what you see." />

    <section className="bg-card rounded-2xl border p-5 md:p-6">
      <div className="text-positive flex items-center gap-2 text-[13px] font-medium"><ShieldCheck className="size-4" aria-hidden="true" />Local-first, with explicit research sharing</div>
      <h2 className="mt-2 max-w-2xl text-xl font-semibold tracking-[-0.02em]">Point your coding agent at this CLI</h2>
      <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">Track cash flow, inspect holdings, model goals, and prepare tax questions from the site, the CLI, or your own coding agent; financial planning stays available without AI keys (<Link className="text-brand hover:underline" href="/planning">build a plan</Link>, <Link className="text-brand hover:underline" href="/research">open research</Link>). Paste the block below into the file your agent reads at startup; it needs nothing else to work.</p>
      <div className="mt-4"><CopyCommand command={AGENT_BRIEF} /></div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">{placements.map(({ tool, where }) => <div key={tool} className="flex gap-2"><dt className="font-medium">{tool}</dt><dd className="text-muted-foreground">{where}</dd></div>)}</dl>
      <p className="text-muted-foreground mt-3 text-xs leading-5">Then let it run <code>bin/fin help</code>. Commands are grouped by what they answer, and <code>bin/fin &lt;command&gt; --help</code> lists that command’s flags and whether it touches the network.</p>
    </section>

    <Section className="mt-10" title="Commands by question" description="Each one is a page here, as a command. Add --json to any of them." surface>
      <div className="divide-y">
        {commandGroups.map((g) => (
          <div key={g.title} className="px-4 py-4 md:px-5">
            <h3 className="text-[13px] font-semibold">{g.title}</h3>
            <ul className="mt-2 space-y-2.5">
              {g.rows.map(([cmd, what]) => (
                <li key={cmd} className="grid gap-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:items-center md:gap-4">
                  <CopyCommand command={cmd} />
                  <span className="text-muted-foreground text-[13px] leading-5">{what}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>

    <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-3 lg:gap-8">
      {workflows.map(({ title, detail, commands }) => (
        <Section key={title} title={title} description={detail}>
          <div className="space-y-2">{commands.map((command) => <CopyCommand key={command} command={command} />)}</div>
        </Section>
      ))}
    </div>

    <Section className="mt-10" title="What the CLI promises an agent" surface>
      <dl className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2 md:p-5">{guarantees.map(([title, detail]) => <div key={title}><dt className="text-sm font-medium">{title}</dt><dd className="text-muted-foreground mt-1 text-[13px] leading-6">{detail}</dd></div>)}</dl>
    </Section>

    <Disclosure className="mt-8" summary="Connect only what you need">
      <div className="max-w-3xl space-y-3">
        <p className="text-muted-foreground text-[13px] leading-6">The local dashboard, planning, tax worksheet, uploads, and Excel export need no paid service. Bank sync uses SimpleFIN. Research needs one AI provider; market data and public search are optional additions. Add keys to your local environment file and restart. Settings never displays secret values.</p>
        <div className="text-brand flex flex-wrap gap-x-4 gap-y-2 text-[13px]"><a className="hover:underline" href="https://bridge.simplefin.org/" target="_blank" rel="noreferrer">SimpleFIN bank sync</a><a className="hover:underline" href="https://console.anthropic.com/" target="_blank" rel="noreferrer">Anthropic API</a><a className="hover:underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI API</a><a className="hover:underline" href="https://build.nvidia.com/" target="_blank" rel="noreferrer">NVIDIA NIM</a><a className="hover:underline" href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noreferrer">Alpha Vantage</a><a className="hover:underline" href="https://dashboard.exa.ai/" target="_blank" rel="noreferrer">Exa search</a></div>
        <CopyCommand command="bin/fin doctor --json" />
        <p className="text-muted-foreground text-xs leading-5">Research sends your prompt to your selected provider. Private context requires a per-run choice; planning inputs and spreadsheets require their own sharing switches too. Enabling AI categorization or cash parsing can send transaction details to configured providers. Keep this single-owner app on localhost or behind your own authenticated private network.</p>
      </div>
    </Disclosure>
  </>;
}
