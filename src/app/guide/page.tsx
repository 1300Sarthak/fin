import Link from "next/link";
import { Terminal, Sparkles, FileSpreadsheet, ShieldCheck, ArrowUpRight, Bot } from "lucide-react";
import { PageHeader } from "@/components/page-header";
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
  { icon: Terminal, title: "Bring your own agent", detail: "Give a terminal agent the same facts you see here. Commands share the dashboard’s calculations, group themselves in `fin help`, and return structured JSON.", commands: ["bin/fin brief --json", "bin/fin burn 2026-06 2026-08 --json", "bin/fin context --json", "bin/fin help --json"] },
  { icon: Sparkles, title: "Research with evidence", detail: "Investigate companies, compare scenarios, and use financial tools. Without --run you get a preview of the provider, the limits and the privacy terms — no request leaves the machine.", commands: ['bin/fin research "Compare VTI and a concentrated stock portfolio"', "bin/fin research tools --json", 'bin/fin research "Review my savings plan" --run --with-context --json'] },
  { icon: FileSpreadsheet, title: "Plan with your spreadsheets", detail: "Read CSV and XLSX locally — no ledger transactions are imported. Choose sharing per file, then export a portable workbook.", commands: ["bin/fin import examples/monthly-budget.csv --json", "bin/fin spreadsheets list --json", "bin/fin plan --json", "bin/fin export --out finance-export.xlsx --json"] },
];
const guarantees = [
  ["One JSON value, one stream", "--json prints a single JSON value on stdout and nothing else, so the output pipes straight into a parser."],
  ["Failures are loud", "Every error prints to stderr and exits 1. With --json the error is a {\"ok\":false,\"error\":{\"message\"}} envelope, still on stderr."],
  ["No silent defaults", "An unknown flag, an unknown verb, or a value outside the allowed set stops the command and names what it accepts instead."],
  ["Local by default", "Only research --run, sync, categorize and free-text cash reach the network. bin/fin doctor reports your configuration without contacting anyone."],
];
export default function GuidePage() {
  return <div className="mx-auto max-w-5xl"><PageHeader title="Your money. Your tools." description="One financial workspace for you and the agents you choose." />
    <div className="mb-7 rounded-2xl border bg-gradient-to-br from-positive/10 via-background to-background p-6 sm:p-8"><div className="mb-4 flex items-center gap-2 text-sm text-positive"><ShieldCheck className="size-4" /> Local-first, with explicit research sharing</div><h2 className="max-w-2xl text-3xl font-semibold tracking-tight">From a clearer picture to a practical plan.</h2><p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">Track cash flow, inspect holdings, model goals, and prepare tax questions. Use the site, the CLI, or your own coding agent. Financial planning stays available without AI keys.</p><div className="mt-5 flex flex-wrap gap-4 text-sm"><Link href="/planning" className="rounded-lg bg-primary px-4 py-2 text-primary-foreground">Build a plan</Link><Link href="/research" className="flex items-center gap-1 underline">Open research <ArrowUpRight className="size-4" /></Link></div></div>
    <section className="mb-7 space-y-4 rounded-xl border p-6"><div className="flex items-center gap-2"><Bot className="size-5 text-positive" /><h2 className="text-lg font-semibold">Point your coding agent at this CLI</h2></div><p className="max-w-3xl text-sm leading-6 text-muted-foreground">The whole dashboard is also <code className="text-xs">bin/fin</code>, and it shares its calculations with these pages, so an agent driving the CLI cannot disagree with what you see here. Paste the block below into the file your agent reads at startup; it needs nothing else to work.</p>
      <CopyCommand command={AGENT_BRIEF} />
      <dl className="grid gap-3 text-sm sm:grid-cols-2">{placements.map(({ tool, where }) => <div key={tool} className="rounded-lg border p-3"><dt className="font-medium">{tool}</dt><dd className="mt-1 text-muted-foreground">{where}</dd></div>)}</dl>
      <p className="text-xs leading-5 text-muted-foreground">Then let it run <code>bin/fin help</code>. Commands are grouped by what they answer, and <code>bin/fin &lt;command&gt; --help</code> lists that command’s flags and whether it touches the network.</p></section>
    <div className="grid gap-5 lg:grid-cols-3">{workflows.map(({ icon: Icon, title, detail, commands }) => <section key={title} className="min-w-0 space-y-4 rounded-xl border p-5"><Icon className="size-5 text-positive" /><h2 className="font-semibold">{title}</h2><p className="text-sm leading-6 text-muted-foreground">{detail}</p><div className="space-y-2">{commands.map(command => <CopyCommand key={command} command={command} />)}</div></section>)}</div>
    <section className="mt-7 space-y-4 rounded-xl border p-6"><h2 className="text-lg font-semibold">What the CLI promises an agent</h2><dl className="grid gap-4 sm:grid-cols-2">{guarantees.map(([title, detail]) => <div key={title}><dt className="text-sm font-medium">{title}</dt><dd className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</dd></div>)}</dl></section>
    <section className="mt-7 space-y-4 rounded-xl border p-6"><h2 className="text-lg font-semibold">Connect only what you need</h2><p className="text-sm leading-6 text-muted-foreground">The local dashboard, planning, tax worksheet, uploads, and Excel export need no paid service. Bank sync uses SimpleFIN. Research needs one AI provider; market data and public search are optional additions. Add keys to your local environment file and restart. Settings never displays secret values.</p><div className="flex flex-wrap gap-4 text-sm underline"><a href="https://bridge.simplefin.org/" target="_blank" rel="noreferrer">SimpleFIN bank sync</a><a href="https://console.anthropic.com/" target="_blank" rel="noreferrer">Anthropic API</a><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI API</a><a href="https://build.nvidia.com/" target="_blank" rel="noreferrer">NVIDIA NIM</a><a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noreferrer">Alpha Vantage</a><a href="https://dashboard.exa.ai/" target="_blank" rel="noreferrer">Exa search</a></div><CopyCommand command="bin/fin doctor --json" /><p className="text-xs leading-5 text-muted-foreground">Research sends your prompt to your selected provider. Private context requires a per-run choice; planning inputs and spreadsheets require their own sharing switches too. Enabling AI categorization or cash parsing can send transaction details to configured providers. Keep this single-owner app on localhost or behind your own authenticated private network.</p></section>
  </div>;
}
