import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { dataTable, DeltaText, Disclosure, EmptyState, HelpTip, inRange, Money, PageHeader, RangePicker, resolveRange, Section, Stat, StatGroup } from "@/components/kit";
import { TimeSeriesChart } from "@/components/kit/time-series-chart";
import { getNetWorthTimeline } from "@/lib/net-worth-timeline";
import { txnHref } from "@/lib/txn-filter-core";
import { HistoryBy } from "./_components/history-by";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { History as HistoryIcon } from "lucide-react";
import {
  getPeriodHistory,
  getPeriodBreakdown,
  type PeriodType,
  type CatFlow,
} from "@/lib/history";
import { getMilestones, type MilestoneLine, type HistoryMilestone } from "@/lib/milestones";
import { MilestoneDialog } from "@/components/milestone-dialog";
import { formatUSD, formatPct, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getLiquidMoneySummary, resolveInclusion } from "@/lib/networth";
import { getAccountsList } from "@/lib/queries";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";

export const dynamic = "force-dynamic";

function ChangeCell({ cents, pct }: { cents: number; pct: number | null }) {
  if (cents === 0) return <span className="text-muted-foreground">—</span>;
  const up = cents > 0;
  return (
    <span className={cn("tabular-nums", up ? "text-positive" : "text-negative")}>
      {up ? "+" : "−"}
      {formatUSD(Math.abs(cents))}
      {pct != null && (
        <span className="ml-1 opacity-70">({formatPct(Math.abs(pct), 1)})</span>
      )}
    </span>
  );
}

function FlowRow({ f, goodWhenUp, href }: { f: CatFlow; goodWhenUp: boolean; href: string }) {
  const up = f.deltaCents > 0;
  const positive = goodWhenUp ? up : !up;
  return (
    <Link href={href} className="hoverable group flex items-center justify-between gap-3 px-4 py-2.5 text-sm md:px-5">
      <span className="truncate group-hover:underline">{f.name}</span>
      <span className="flex items-center gap-2">
        {Math.abs(f.deltaCents) >= 100 && (
          <span
            className={cn(
              "text-xs tabular-nums",
              positive ? "text-positive" : "text-negative",
            )}
          >
            {up ? "↑" : "↓"}
            {formatUSD(Math.abs(f.deltaCents), false)}
          </span>
        )}
        <span className="tabular-nums">{formatUSD(f.cents)}</span>
      </span>
    </Link>
  );
}

function LineAmount({ cents }: { cents: number }) {
  const isDebt = cents < 0;
  return (
    <span className={cn("tabular-nums", isDebt && "text-negative")}>
      {isDebt ? "−" : ""}
      {formatUSD(Math.abs(cents))}
    </span>
  );
}

function MilestoneLines({ lines }: { lines: MilestoneLine[] }) {
  return (
    <div className="space-y-1.5">
      {lines.map((line) => (
        <div
          key={`${line.label}-${line.note ?? ""}`}
          className="grid gap-x-3 text-sm sm:grid-cols-[minmax(9rem,1fr)_auto]"
        >
          <div className="min-w-0">
            <span className="font-medium">{line.label}</span>
            {line.note && (
              <span className="text-muted-foreground ml-1">({line.note})</span>
            )}
          </div>
          <LineAmount cents={line.cents} />
        </div>
      ))}
    </div>
  );
}

function getMilestoneRows(milestones: HistoryMilestone[]) {
  return milestones
    .map((m, i) => ({
      ...m,
      changeCents: i === 0 ? 0 : m.totalCents - milestones[i - 1].totalCents,
      // The milestone one step older, used to prefill an edit's sibling lines.
      previous: i === 0 ? undefined : milestones[i - 1],
    }))
    .reverse();
}

function Milestones({ milestoneRows, latest }: { milestoneRows: ReturnType<typeof getMilestoneRows>; latest?: HistoryMilestone }) {
  return (
    <Section title="Manual net worth milestones" description={milestoneRows.length ? `${milestoneRows.length} checkpoints recorded by hand` : "Checkpoints you record by hand"} actions={<MilestoneDialog previous={latest} />} surface>
      {milestoneRows.length === 0 ? <p className="text-muted-foreground px-5 py-6 text-sm">No checkpoints yet.</p> : (
        <ul className="divide-y">
          {milestoneRows.map((m) => (
            <li key={m.date} className="px-4 py-3 md:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="flex min-w-0 items-center gap-1">
                  <span className="text-sm font-medium">{formatDate(m.date)}</span>
                  <MilestoneDialog milestone={m} previous={m.previous} />
                  {m.goal && <span className="text-muted-foreground truncate text-xs">· Goal: {m.goal}</span>}
                </div>
                <div className="flex items-baseline gap-3">
                  <ChangeCell cents={m.changeCents} pct={null} />
                  <span className="num text-sm font-semibold">{formatUSD(m.totalCents)}</span>
                </div>
              </div>
              {m.totalCents !== m.computedCents && <p className="text-muted-foreground mt-0.5 text-right text-xs" title="The total you recorded differs from the sum of the lines">lines {formatUSD(m.computedCents)}</p>}
              <Disclosure summary={`${m.included.length} included${m.excluded?.length ? ` · ${m.excluded.length} tracked separately` : ""}`}>
                <div className="grid gap-4 pb-1 sm:grid-cols-2">
                  <div><p className="text-muted-foreground mb-1.5 text-xs">Included accounts</p><MilestoneLines lines={m.included} /></div>
                  <div><p className="text-muted-foreground mb-1.5 text-xs">Tracked separately</p>{m.excluded && m.excluded.length > 0 ? <MilestoneLines lines={m.excluded} /> : <span className="text-muted-foreground text-sm">—</span>}</div>
                </div>
                {m.note && <p className="text-muted-foreground mt-2 text-xs">{m.note}</p>}
              </Disclosure>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

type Params = Record<string, string | string[] | undefined>;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const at = typeof sp.at === "string" ? sp.at : undefined;
  // `?period=week` is the old spelling; `period` now belongs to the range picker.
  const periodType: PeriodType = sp.by === "week" || sp.period === "week" ? "week" : "month";
  const range = resolveRange(sp, { fallback: "all" });

  const [allRows, milestones, liquidMoney, accounts, timeline] = await Promise.all([
    getPeriodHistory(periodType),
    getMilestones(),
    getLiquidMoneySummary(),
    getAccountsList(),
    resolveInclusion(undefined).then(getNetWorthTimeline),
  ]);
  const chartWindow = { from: range.from, to: range.to };
  const rows = allRows.filter((r) => inRange(range, r.end) || inRange(range, r.start));
  const milestoneRows = getMilestoneRows(milestones);
  const latestMilestone = milestones[milestones.length - 1];
  const header = (description: string) => (
    <PageHeader title="History" description={description} actions={<><HistoryBy value={periodType} /><RangePicker value={range} fallback="all" /></>} />
  );

  // A brand-new install still produces one all-zero period; that is not history.
  if (accounts.length === 0 && milestones.length === 0) {
    return (
      <>
        <PageHeader title="History" description="Look back at how your money grew over time." />
        <EmptyState icon={HistoryIcon} title="No history yet" description={NO_DATA_DESCRIPTION} action={<ConnectDataActions />} />
      </>
    );
  }

  if (allRows.length === 0) {
    // No synced history yet — the hand-recorded checkpoints carry the page.
    if (milestones.length === 0) {
      return (
        <>
          <PageHeader title="History" description="Look back at how your money grew over time." />
          <EmptyState icon={HistoryIcon} title="No history yet" description="Sync an account, or add a net worth checkpoint by hand to start the record." />
        </>
      );
    }
    const latestManual = milestones[milestones.length - 1];
    const oldestManual = milestones[0];
    const manualChange = latestManual.totalCents - oldestManual.totalCents;
    return (
      <>
        {header("Look back at how your money grew over time.")}
        <StatGroup cols={3}>
          <Stat label="Latest manual net worth" value={<Money cents={latestManual.totalCents} />} />
          <Stat label="Manual history change" value={<Money cents={manualChange} signed />} tone={manualChange >= 0 ? "positive" : "negative"} />
          <Stat label="Manual entries" value={milestones.length} sub={`${formatDate(oldestManual.date)} to ${formatDate(latestManual.date)}`} />
        </StatGroup>
        <Section className="mt-10" title="Manual net worth history" surface bodyClassName="px-2 pt-4 md:px-4">
          <TimeSeriesChart points={milestones.map((m) => ({ date: m.date, cents: m.totalCents, kind: "manual" as const }))} window={chartWindow} />
        </Section>
        <div className="mt-10"><Milestones milestoneRows={milestoneRows} latest={latestMilestone} /></div>
        <EmptyState className="mt-10" icon={HistoryIcon} title="No synced history yet" description="Once you've synced some accounts, your net worth by week and month will build up here." />
      </>
    );
  }

  const shown = rows.length ? rows : allRows.slice(0, 1);
  const selected = shown.find((r) => r.key === at) ?? allRows.find((r) => r.key === at) ?? shown[0];
  const breakdown = await getPeriodBreakdown(periodType, selected.key);

  const latest = shown[0];
  const oldest = shown[shown.length - 1];
  const spanChange = latest.netWorthCents - oldest.netWorthCents;
  const totalSaved = shown.reduce((s, r) => s + r.savedCents, 0);
  const unit = periodType === "week" ? "weeks" : "months";
  const atHref = (key: string) => {
    const q = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    q.set("at", key);
    return `/history?${q}`;
  };
  const span = { from: selected.start, to: selected.end };

  return (
    <>
      {header("Look back at how your money grew, and where it came from and went.")}

      {/* The one loud thing: net worth now, its change over the range, and the line. */}
      <section aria-labelledby="hist-nw" className="bg-card rounded-2xl border">
        <div className="px-5 pt-5 md:px-6 md:pt-6">
          <div id="hist-nw" className="text-muted-foreground text-[13px]">Net worth at the end of {latest.label}</div>
          <div className="mt-1 text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] md:text-[46px]"><Money cents={latest.netWorthCents} dimCents /></div>
          <div className="mt-2"><DeltaText cents={spanChange} label={`over ${shown.length} ${unit}`} /></div>
        </div>
        <div className="px-2 pt-4 md:px-4"><TimeSeriesChart points={timeline.points} realFrom={timeline.realFrom} window={chartWindow} /></div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 border-t px-5 py-4 md:px-6 lg:grid-cols-4">
          {[
            { label: `Saved across ${shown.length} ${unit}`, cents: totalSaved, tone: totalSaved >= 0 ? "text-positive" : "text-negative", help: "Income minus spending, summed over the periods shown." },
            { label: "Liquid assets today", cents: liquidMoney.liquidAssetsCents, tone: "", help: "Spendable balances only, with investments kept separate." },
            { label: "Liabilities today", cents: liquidMoney.liabilitiesCents, tone: "text-negative", help: undefined },
            { label: "Liquid after liabilities", cents: liquidMoney.liquidAfterLiabilitiesCents, tone: liquidMoney.liquidAfterLiabilitiesCents < 0 ? "text-negative" : "text-positive", help: undefined },
          ].map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-muted-foreground flex items-center gap-1 truncate text-xs">{f.label}{f.help && <HelpTip label={f.label}>{f.help}</HelpTip>}</dt>
              <dd className={cn("num mt-0.5 text-[15px] font-semibold", f.tone)}>{formatUSD(f.cents)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Section className="mt-10" title={`By ${periodType}`} description={`${shown.length} ${unit} · ${range.label}. Pick one to see where the money came from and went.`}>
        <div className={dataTable.shell}>
          <Table containerClassName="max-h-[70dvh]">
            <TableHeader className={dataTable.stickyHead}>
              <TableRow>
                <TableHead className={dataTable.edge}>Period</TableHead>
                <TableHead className={dataTable.num}>Net worth</TableHead>
                <TableHead className={cn(dataTable.num, "hidden sm:table-cell")}>Change</TableHead>
                <TableHead className={cn(dataTable.num, "hidden md:table-cell")}>Income</TableHead>
                <TableHead className={cn(dataTable.num, "hidden lg:table-cell")}>Retirement</TableHead>
                <TableHead className={cn(dataTable.num, "hidden lg:table-cell")}>Earned / invested</TableHead>
                <TableHead className={cn(dataTable.num, "hidden md:table-cell")}>Spending</TableHead>
                <TableHead className={cn(dataTable.num, dataTable.edge)}>Saved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.key} className={cn("hoverable", r.key === selected.key && "bg-brand/5")}>
                  <TableCell className={dataTable.edge}>
                    <Link href={atHref(r.key)} scroll={false} className="inline-flex items-center gap-1 font-medium hover:underline" aria-current={r.key === selected.key ? "true" : undefined}>
                      {r.label}
                      {r.key === selected.key && <ChevronRight className="text-brand size-3.5" aria-hidden="true" />}
                    </Link>
                  </TableCell>
                  <TableCell className={cn(dataTable.num, "font-medium")}>{formatUSD(r.netWorthCents)}</TableCell>
                  <TableCell className={cn(dataTable.num, "hidden sm:table-cell")}><ChangeCell cents={r.changeCents} pct={r.changePct} /></TableCell>
                  <TableCell className={cn(dataTable.num, "text-positive hidden md:table-cell")}>
                    {r.incomeCents ? <Link className="hover:underline" href={txnHref({ from: r.start, to: r.end, kind: "income" })}>{formatUSD(r.incomeCents)}</Link> : "—"}
                  </TableCell>
                  <TableCell className={cn(dataTable.num, "text-info hidden lg:table-cell")}>{r.retirementContributionCents ? formatUSD(r.retirementContributionCents) : "—"}</TableCell>
                  <TableCell className={cn(dataTable.num, "text-positive hidden font-medium lg:table-cell")}>{r.earnedAndInvestedCents ? formatUSD(r.earnedAndInvestedCents) : "—"}</TableCell>
                  <TableCell className={cn(dataTable.num, "hidden md:table-cell")}>
                    {r.spendingCents ? <Link className="hover:underline" href={txnHref({ from: r.start, to: r.end, kind: "expense" })}>{formatUSD(r.spendingCents)}</Link> : "—"}
                  </TableCell>
                  <TableCell className={cn(dataTable.num, dataTable.edge, "font-medium", r.savedCents < 0 && "text-negative")}>{formatUSD(r.savedCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      {breakdown && (
        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-8">
          {([
            ["Money in", breakdown.income, true, "income", breakdown.incomeTotal],
            ["Money out", breakdown.spending, false, "expense", breakdown.spendingTotal],
          ] as const).map(([title, flows, good, kind, total]) => (
            <Section
              key={title}
              title={`${title} · ${breakdown.label}`}
              description={<>Total <Link className="text-foreground font-medium hover:underline" href={txnHref({ ...span, kind })}>{formatUSD(total)}</Link>; arrows compare to the previous {periodType}.</>}
              surface
            >
              {flows.length === 0 ? (
                <p className="text-muted-foreground px-5 py-6 text-sm">No {kind === "income" ? "income" : "spending"} recorded this {periodType}.</p>
              ) : (
                <div className="divide-y">
                  {flows.map((f) => <FlowRow key={f.name} f={f} goodWhenUp={good} href={txnHref({ ...span, category: f.name, kind })} />)}
                </div>
              )}
            </Section>
          ))}
        </div>
      )}

      <div className="mt-10"><Milestones milestoneRows={milestoneRows} latest={latestMilestone} /></div>

      <p className="text-muted-foreground mt-6 text-xs">History grows as you keep syncing; snapshots are saved daily.</p>
    </>
  );
}
