import Link from "next/link";
import { ArrowUpRight, Landmark } from "lucide-react";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";
import { AccountIcon } from "@/components/account-icon";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeltaText, Disclosure, EmptyState, HelpTip, Money, PageHeader, RangePicker, Section, dataTable, inRange, resolveRange } from "@/components/kit";
import { getInvestmentsWorkspace } from "@/lib/workspaces";
import { getInvestmentHistory, investmentFlows, HISTORY_KINDS, type HistoryEvent, type HistoryKind, type InvestmentHistory, type SymbolSummary } from "@/lib/investment-history";
import { getAccountsList } from "@/lib/queries";
import { getInvestmentValueGap, investmentValueGapNote } from "@/lib/holdings";
import { ACCOUNT_TYPE_META } from "@/lib/accounts";
import { txnHref } from "@/lib/txn-filter";
import { formatDate, formatDateShort, formatUSD, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ValueChart } from "./_components/value-chart";
import { HistoryControls, type HistoryView } from "./_components/history-controls";

export const dynamic = "force-dynamic";

const DESCRIPTION = "What your investment accounts are worth, and what you bought, when, and with what money.";
const TIMELINE_LIMIT = 40;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Money arriving in the account for these kinds; leaving for the rest. */
const INFLOW = new Set<HistoryKind>(["contribution", "transfer-in", "sell", "dividend", "interest"]);
const KIND_TONE: Partial<Record<HistoryKind, string>> = {
  contribution: "text-info", "transfer-in": "text-info", "transfer-out": "text-info",
  dividend: "text-positive", interest: "text-positive", fee: "text-negative",
};

export default async function InvestmentsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, { fallback: "ytd" });
  const view: HistoryView = one(sp.view) === "securities" ? "securities" : one(sp.view) === "funding" ? "funding" : "timeline";
  const rawAccount = Number(one(sp.account));
  const symbol = one(sp.symbol)?.slice(0, 60) ?? null;
  const kind = HISTORY_KINDS.find((k) => k === one(sp.kind)) ?? null;
  const all = one(sp.all) === "1";
  const more = one(sp.more) === "1";

  const [ws, accountList, gap] = await Promise.all([getInvestmentsWorkspace(), getAccountsList(), getInvestmentValueGap()]);
  if (ws.accounts.length === 0) {
    return <>
      <PageHeader title="Investments" description={DESCRIPTION} />
      {accountList.length === 0
        ? <EmptyState icon={Landmark} title="No investments to show yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
        : <EmptyState icon={Landmark} title="No investment accounts yet" description="None of your connected accounts is a brokerage, IRA, HSA, or crypto account. Sync a provider that holds one, or check that it is still marked active." action={<Link href="/accounts" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>Review accounts</Link>} />}
    </>;
  }

  const span = { from: range.from ?? undefined, to: range.to ?? undefined };
  // Portfolio-wide flows for the range, then the history narrowed by the filters (a bad account id just drops that filter).
  const overall = await getInvestmentHistory({ ...span, includeInternal: true });
  const accountId = Number.isInteger(rawAccount) && overall.accounts.some((a) => a.accountId === rawAccount) ? rawAccount : null;
  const history = accountId == null && !symbol ? overall : await getInvestmentHistory({ ...span, accountId: accountId ?? undefined, symbol: symbol ?? undefined, includeInternal: true });

  const flows = investmentFlows(overall);
  const trendInRange = ws.trend.filter((p) => inRange(range, p.month));
  const trend = (trendInRange.length >= 2 ? trendInRange : ws.trend).map((p) => ({ date: p.month, valueCents: p.valueCents }));
  const change = trend.length >= 2 ? trend[trend.length - 1].valueCents - trend[0].valueCents : null;

  /** This page's URL with some params changed, keeping the range. */
  const here = (changes: Record<string, string | null>, hash = "#history") => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) { const x = one(v); if (x) qs.set(k, x); }
    qs.delete("more");
    for (const [k, v] of Object.entries(changes)) { if (v == null) qs.delete(k); else qs.set(k, v); }
    const s = qs.toString();
    return `/investments${s ? `?${s}` : ""}${hash}`;
  };
  const timelineFor = (k: HistoryKind | null, acct: number | null = accountId) => here({ view: null, kind: k, account: acct == null ? null : String(acct) });

  const flowItems = [
    { label: "Contributions", cents: flows.contributionCents, tone: "text-info", kind: "contribution" as const, help: "Money paid into retirement and HSA accounts. A contribution Fidelity reports twice on one day (once negative, once positive) counts once." },
    { label: "Deposits", cents: flows.transferInCents, tone: "text-info", kind: "transfer-in" as const, help: "Transfers into a brokerage or crypto account from a bank." },
    { label: "Dividends & interest", cents: flows.dividendCents + flows.interestCents, tone: "text-positive", kind: "dividend" as const, help: `Dividends ${formatUSD(flows.dividendCents)}, interest ${formatUSD(flows.interestCents)}. The link opens dividends; pick interest in the kind filter.` },
    { label: "Moved out", cents: flows.transferOutCents, tone: "", kind: "transfer-out" as const, help: "Withdrawals and transfers out of the investment accounts." },
    { label: "Fees", cents: flows.feeCents, tone: flows.feeCents ? "text-negative" : "", kind: "fee" as const, help: "Fees, commissions and foreign tax withheld. Fidelity's bare \"Fidelity\" money-market legs are sweeps, not fees." },
  ];

  const byKind = kind ? history.events.filter((e) => e.kind === kind) : history.events;
  const visible = all ? byKind : byKind.filter((e) => !e.internal);
  const hidden = byKind.length - byKind.filter((e) => !e.internal).length;
  const symbolOptions = [...new Set(overall.symbols.filter((s) => s.symbol).map((s) => s.symbol!))].sort();
  const historyAccounts = overall.accounts.filter((a) => a.events || a.holdings).map((a) => ({ id: a.accountId, name: a.account }));
  const typeTotal = ws.byType.reduce((s, t) => s + t.valueCents, 0);

  return <>
    <PageHeader title="Investments" description={DESCRIPTION} actions={<RangePicker value={range} fallback="ytd" />} />

    {/* The one loud thing: what it is all worth, and how that moved. */}
    <section aria-labelledby="inv-value" className="bg-card rounded-2xl border">
      <div className="px-5 pt-5 md:px-6 md:pt-6">
        <div id="inv-value" className="text-muted-foreground flex items-center gap-1 text-[13px]">
          Account value, incl. cash
          <HelpTip label="About account value">Today&apos;s balances of the active brokerage, retirement, HSA and crypto accounts, as the institutions report them, so uninvested cash is included. The chart is the recorded total on days every one of those accounts had a snapshot.</HelpTip>
        </div>
        <div className="mt-1 text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] md:text-[46px]"><Money cents={ws.totalCents} dimCents /></div>
        {gap.uninvestedCents !== 0 || gap.positionsElsewhereCents !== 0 ? <p className="text-muted-foreground mt-1 text-[13px]">{investmentValueGapNote(gap, formatUSD)}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          {change != null
            ? <span className="inline-flex items-center gap-1"><DeltaText cents={change} label={`since ${formatDateShort(trend[0].date)}`} /><HelpTip label="About this change">Recorded value at the end minus the start of the chart. It includes money you paid in, so it is not a return.</HelpTip></span>
            : <span className="text-muted-foreground">Not enough snapshots yet to show a change.</span>}
          {trendInRange.length < 2 && trend.length >= 2 && <span className="text-muted-foreground">Chart shows every recorded day; this range has fewer than two.</span>}
        </div>
      </div>
      <div className="px-2 pt-4 md:px-4">
        {trend.length >= 2 ? <ValueChart data={trend} /> : <p className="text-muted-foreground px-3 py-10 text-center text-sm">The value chart fills in as daily snapshots accumulate.</p>}
      </div>
      <div className="text-muted-foreground mt-3 border-t px-5 pt-4 text-xs md:px-6">Money in and out · {range.label}</div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 pt-2 pb-4 md:px-6 lg:grid-cols-5">
        {flowItems.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-muted-foreground flex items-center gap-1 text-xs"><span className="truncate">{f.label}</span><HelpTip label={`About ${f.label}`}>{f.help}</HelpTip></dt>
            <dd className="mt-0.5"><Link href={timelineFor(f.kind, null)} className={cn("num rounded-sm text-[15px] font-semibold underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring", f.tone)}><Money cents={f.cents} /></Link></dd>
          </div>
        ))}
      </dl>
    </section>

    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
      <Section className="min-w-0" title="Accounts" description={`${ws.accounts.length} investment account${ws.accounts.length === 1 ? "" : "s"} · open one for its transactions in this range`} surface>
        <ul className="stagger divide-y">
          {ws.accounts.map((a) => (
            <li key={a.id}>
              <Link href={txnHref({ account: a.id, ...span })} className="hoverable flex items-center gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg"><AccountIcon type={a.type as keyof typeof ACCOUNT_TYPE_META} className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">{[a.institution, ACCOUNT_TYPE_META[a.type as keyof typeof ACCOUNT_TYPE_META]?.label ?? a.type].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="text-right">
                  <Money cents={a.balanceCents} className="block text-sm font-medium" />
                  <span className="num text-muted-foreground block text-xs">{ws.totalCents ? ((a.balanceCents / ws.totalCents) * 100).toFixed(1) : "0.0"}%</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section className="min-w-0" title="By account type" description="Share of invested value">
        <ul className="space-y-3">
          {ws.byType.map((t) => {
            const pct = typeTotal ? (t.valueCents / typeTotal) * 100 : 0;
            return (
              <li key={t.id}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate">{ACCOUNT_TYPE_META[t.id as keyof typeof ACCOUNT_TYPE_META]?.label ?? t.name}</span>
                  <span className="num shrink-0"><Money cents={t.valueCents} /> <span className="text-muted-foreground text-xs">{pct.toFixed(1)}%</span></span>
                </div>
                <div className="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full"><div className="bg-chart-1 h-full rounded-full" style={{ width: `${pct}%` }} /></div>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>

    <Section id="history" className="mt-10" title="What you bought, when, and how" description={`${range.label}. Every row opens the transaction behind it. Where the feed does not say, this says unknown.`}>
      <div className="mb-3">
        <HistoryControls view={view} account={accountId} symbol={symbol} kind={kind} all={all} hidden={hidden} accounts={historyAccounts} symbols={symbolOptions} kinds={HISTORY_KINDS} />
      </div>
      {view === "timeline" && <Timeline events={visible} more={more} moreHref={here({ more: "1" })} />}
      {view === "securities" && <Securities symbols={history.symbols} timelineFor={(key) => here({ view: null, symbol: key })} />}
      {view === "funding" && <Funding history={history} timelineFor={timelineFor} span={span} />}
    </Section>

    <Disclosure className="mt-10" summary="What this data can't tell you" hint={`${history.limits.length} limits`}>
      <ul className="text-muted-foreground max-w-[75ch] list-disc space-y-1.5 pl-5 text-[13px]">
        <li>Contributions are deposits, not spending or earnings. They show as positive amounts even when the brokerage books them as a negative cash leg.</li>
        {history.limits.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </Disclosure>
  </>;
}


function partyText(e: HistoryEvent): { text: string; unknown: boolean } | null {
  const p = e.fundedBy ?? e.sentTo;
  if (!p) return null;
  if (p.kind === "unknown") return { text: e.fundedBy ? "Source unknown" : "Destination unknown", unknown: true };
  const label = p.label.charAt(0).toUpperCase() + p.label.slice(1);
  if (!p.inferred) return { text: label, unknown: false };
  return { text: p.kind === "payroll" ? `${label}, assumed for a workplace plan` : `${label}, matched by amount and date`, unknown: false };
}

function Timeline({ events, more, moreHref }: { events: HistoryEvent[]; more: boolean; moreHref: string }) {
  if (!events.length) return <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-sm">Nothing matches these filters in this range. Positions bought before the ledger starts have no purchase on record; By security shows what is known about them.</p>;
  const shown = more ? events : events.slice(0, TIMELINE_LIMIT);
  const months: { key: string; rows: HistoryEvent[] }[] = [];
  for (const e of shown) {
    const key = e.date.slice(0, 7);
    if (months.at(-1)?.key !== key) months.push({ key, rows: [] });
    months.at(-1)!.rows.push(e);
  }
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      {months.map((m) => (
        <div key={m.key}>
          <div className="bg-muted/40 text-muted-foreground flex justify-between border-b px-4 py-1.5 text-xs md:px-5">
            <span>{monthLabel(`${m.key}-01`)}</span><span>{m.rows.length} event{m.rows.length === 1 ? "" : "s"}</span>
          </div>
          <ul className="divide-y border-b last:border-b-0">
            {m.rows.map((e) => {
              const party = partyText(e);
              const name = e.symbol ? `${e.symbol}${e.security && e.security.toUpperCase() !== e.symbol ? ` · ${e.security}` : ""}` : e.security;
              return (
                <li key={e.txnId}>
                  <Link href={txnHref({ from: e.date, to: e.date, account: e.accountId, q: e.description })} className={cn("hoverable grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,14rem)_auto] md:px-5", e.internal && "opacity-60")}>
                    <span className="num text-muted-foreground pt-0.5 text-[13px]">{formatDateShort(e.date)}</span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", e.confidence === "inferred" && "border-dashed")} title={e.confidence === "inferred" ? "Read from a bare payee name and the sign; the row does not say" : undefined}>{e.label}</span>
                        <span className="truncate text-sm font-medium">{name ?? <span className="text-muted-foreground font-normal">{e.kind === "buy" || e.kind === "sell" ? "Security not named" : e.description}</span>}</span>
                        {e.internal && <span className="text-muted-foreground text-xs">{e.duplicateOf ? `duplicate of #${e.duplicateOf}` : "internal"}</span>}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block truncate text-xs md:hidden">{e.account}{party ? ` · ${party.text}` : ""}</span>
                    </span>
                    <span className="text-muted-foreground hidden min-w-0 text-xs md:block">
                      <span className="block truncate">{e.account}</span>
                      {party && <span className={cn("block truncate", party.unknown && "text-warning")}>{party.text}</span>}
                    </span>
                    <span className={cn("num text-right text-sm font-medium", KIND_TONE[e.kind])}>
                      {e.kind === "other" ? <Money cents={e.rawAmountCents} signed /> : <Money cents={INFLOW.has(e.kind) ? e.amountCents : -e.amountCents} signed />}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {!more && events.length > TIMELINE_LIMIT && (
        <Link href={moreHref} className="hoverable text-muted-foreground block px-4 py-3 text-center text-[13px] font-medium md:px-5">Show all {events.length} events</Link>
      )}
    </div>
  );
}

function Securities({ symbols, timelineFor }: { symbols: SymbolSummary[]; timelineFor: (key: string) => string }) {
  const rows = symbols.filter((s) => s.buys || s.sells || s.currentValueCents != null);
  if (!rows.length) return <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-sm">No securities match these filters.</p>;
  const unknown = <span className="text-muted-foreground">unknown</span>;
  return (
    <div className={dataTable.shell}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={dataTable.edge}>Security</TableHead>
            <TableHead className="hidden lg:table-cell">Accounts</TableHead>
            <TableHead>First bought</TableHead>
            <TableHead className={dataTable.num}>Invested</TableHead>
            <TableHead className={cn(dataTable.num, "hidden md:table-cell")}>Sold</TableHead>
            <TableHead className={cn(dataTable.num, "hidden md:table-cell")}>Income</TableHead>
            <TableHead className={dataTable.num}>Value now</TableHead>
            <TableHead className={cn(dataTable.num, dataTable.edge)}>
              <span className="inline-flex items-center gap-1">Gain<HelpTip label="About gain">Ledger gain is value now plus sales and income, minus purchases, only when the ledger plausibly holds the whole position. Otherwise the broker&apos;s cost basis is used when it reports one; crypto usually has none.</HelpTip></span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const gain = s.ledgerGainCents ?? s.brokerGainCents;
            return (
              <TableRow key={s.key}>
                <TableCell className={cn(dataTable.edge, "max-w-[16rem]")}>
                  <Link href={timelineFor(s.symbol ?? s.security ?? s.key)} className="block rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring underline-offset-4">
                    <span className="block truncate font-medium">{s.symbol ?? s.security ?? "Unnamed security"}</span>
                    {s.symbol && s.security && <span className={cn(dataTable.meta, "block truncate")}>{s.security}</span>}
                  </Link>
                  <span className={cn(dataTable.meta, "block lg:hidden truncate")}>{s.accounts.join(", ")}</span>
                </TableCell>
                <TableCell className={cn(dataTable.meta, "hidden max-w-[14rem] truncate lg:table-cell")}>{s.accounts.join(", ")}</TableCell>
                <TableCell className="num whitespace-nowrap">{s.firstBought ? formatDate(s.firstBought) : <span className="text-muted-foreground" title="No purchase on record: bought before the ledger starts, or the feed never named it">not on record</span>}
                  {(s.buys > 0 || s.sells > 0) && <span className={cn(dataTable.meta, "block")}>{s.buys} buy{s.buys === 1 ? "" : "s"}{s.sells ? `, ${s.sells} sell${s.sells === 1 ? "" : "s"}` : ""}</span>}
                </TableCell>
                <TableCell className={dataTable.num}>{s.investedCents ? <Money cents={s.investedCents} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className={cn(dataTable.num, "hidden md:table-cell")}>{s.proceedsCents ? <Money cents={s.proceedsCents} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className={cn(dataTable.num, "hidden md:table-cell")}>{s.incomeCents ? <Money cents={s.incomeCents} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className={dataTable.num}>{s.currentValueCents != null ? <><Money cents={s.currentValueCents} />{s.shares != null && <span className={cn(dataTable.meta, "block")}>{s.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })} sh</span>}</> : <span className="text-muted-foreground">not held</span>}</TableCell>
                <TableCell className={cn(dataTable.num, dataTable.edge)}>
                  {gain == null ? unknown : <><Money cents={gain} signed tone="auto" /><span className={cn(dataTable.meta, "block")}>{s.ledgerGainCents != null ? "from the ledger" : "vs broker cost"}</span></>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Funding({ history, timelineFor, span }: { history: InvestmentHistory; timelineFor: (k: HistoryKind | null, acct?: number | null) => string; span: { from?: string; to?: string } }) {
  const accounts = history.accounts.filter((a) => a.events || a.holdings);
  if (!accounts.length) return <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-sm">No investment activity matches these filters.</p>;
  return (
    <ul className="stagger bg-card divide-y overflow-hidden rounded-xl border">
      {accounts.map((a) => {
        const sources = history.funding.filter((f) => f.accountId === a.accountId);
        const cells: { label: string; cents: number; kind: HistoryKind }[] = [
          { label: "Contributions", cents: a.contributionCents, kind: "contribution" },
          { label: "Deposits", cents: a.transferInCents, kind: "transfer-in" },
          { label: "Moved out", cents: a.transferOutCents, kind: "transfer-out" },
          { label: "Bought", cents: a.boughtCents, kind: "buy" },
          { label: "Sold", cents: a.soldCents, kind: "sell" },
          { label: "Dividends", cents: a.dividendCents, kind: "dividend" },
          { label: "Interest", cents: a.interestCents, kind: "interest" },
          { label: "Fees", cents: a.feeCents, kind: "fee" },
        ];
        return (
          <li key={a.accountId} className="px-4 py-4 md:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <Link href={txnHref({ account: a.accountId, ...span })} className="truncate text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm">{a.account}</Link>
              <span className="text-muted-foreground text-xs">
                {a.firstActivity ? `First activity ${formatDate(a.firstActivity)}` : "No transactions on record"} · {a.events} event{a.events === 1 ? "" : "s"} · {a.holdings} holding{a.holdings === 1 ? "" : "s"} · balance <Money cents={a.balanceCents} />
              </span>
            </div>
            {cells.every((c) => !c.cents) && <p className="text-muted-foreground mt-2 text-[13px]">No activity in this range.</p>}
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 empty:hidden">
              {cells.filter((c) => c.cents).map((c) => (
                <div key={c.label} className="flex items-baseline justify-between gap-2 sm:block">
                  <dt className="text-muted-foreground text-xs">{c.label}</dt>
                  <dd className="num text-sm"><Link href={timelineFor(c.kind, a.accountId)} className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"><Money cents={c.cents} /></Link></dd>
                </div>
              ))}
            </dl>
            <div className="mt-3">
              <div className="text-muted-foreground mb-1 text-xs">Where the money came from</div>
              {sources.length ? (
                <ul className="space-y-1">
                  {sources.map((f) => (
                    <li key={f.label} className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className={cn("min-w-0 truncate", f.kind === "unknown" && "text-warning")} title={f.label}>
                        {f.kind === "unknown" ? "Unknown — no matching outflow in a linked account" : f.label.charAt(0).toUpperCase() + f.label.slice(1)}
                        {f.inferred && <span className="text-muted-foreground"> · inferred</span>}
                        <span className="text-muted-foreground"> · {f.count}×</span>
                      </span>
                      <Money cents={f.amountCents} className="shrink-0" />
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground text-[13px]">No money paid in during this range.</p>}
            </div>
          </li>
        );
      })}
      <li className="text-muted-foreground flex items-center gap-1 px-4 py-3 text-xs md:px-5">
        <ArrowUpRight className="size-3.5" aria-hidden="true" />Amounts open the timeline filtered to that kind; account names open their transactions.
      </li>
    </ul>
  );
}
