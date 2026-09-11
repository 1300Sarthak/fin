import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { NetWorthChart } from "@/components/net-worth-chart";
import { RangeSelector } from "@/components/range-selector";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { getLiquidMoneySummary } from "@/lib/networth";
import { getAccountsList } from "@/lib/queries";
import { ConnectDataActions, NO_DATA_DESCRIPTION } from "@/components/connect-data";

export const dynamic = "force-dynamic";

const PERIOD_OPTIONS = [
  { value: "month", label: "Monthly" },
  { value: "week", label: "Weekly" },
];

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

function FlowRow({ f, goodWhenUp }: { f: CatFlow; goodWhenUp: boolean }) {
  const up = f.deltaCents > 0;
  const positive = goodWhenUp ? up : !up;
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="truncate">{f.name}</span>
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
    </div>
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

function ManualMilestonesCard({
  milestoneRows,
  latest,
}: {
  milestoneRows: ReturnType<typeof getMilestoneRows>;
  latest?: HistoryMilestone;
}) {
  return (
    <Card className="mb-6 py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Manual net worth milestones</CardTitle>
        <MilestoneDialog previous={latest} />
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Net worth</TableHead>
            <TableHead className="text-right">Change</TableHead>
            <TableHead>Included accounts</TableHead>
            <TableHead>Tracked separately</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {milestoneRows.map((m) => (
            <TableRow key={m.date}>
              <TableCell className="align-top">
                <div className="flex items-center gap-1">
                  <span className="font-medium">{formatDate(m.date)}</span>
                  <MilestoneDialog milestone={m} previous={m.previous} />
                </div>
                {m.goal && (
                  <div className="text-muted-foreground mt-1 text-xs">
                    Goal: {m.goal}
                  </div>
                )}
              </TableCell>
              <TableCell className="align-top text-right font-medium tabular-nums">
                {formatUSD(m.totalCents)}
                {m.totalCents !== m.computedCents && (
                  <div
                    className="text-muted-foreground text-xs font-normal"
                    title="The total you recorded differs from the sum of the lines"
                  >
                    lines {formatUSD(m.computedCents)}
                  </div>
                )}
              </TableCell>
              <TableCell className="align-top text-right">
                <ChangeCell cents={m.changeCents} pct={null} />
              </TableCell>
              <TableCell className="min-w-[18rem] align-top">
                <MilestoneLines lines={m.included} />
                {m.note && (
                  <p className="text-muted-foreground mt-2 text-xs">{m.note}</p>
                )}
              </TableCell>
              <TableCell className="min-w-[15rem] align-top">
                {m.excluded && m.excluded.length > 0 ? (
                  <MilestoneLines lines={m.excluded} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; at?: string }>;
}) {
  const { period, at } = await searchParams;
  const periodType: PeriodType = period === "week" ? "week" : "month";

  const [rows, milestones, liquidMoney, accounts] = await Promise.all([
    getPeriodHistory(periodType),
    getMilestones(),
    getLiquidMoneySummary(),
    getAccountsList(),
  ]);
  const milestoneRows = getMilestoneRows(milestones);
  const latestMilestone = milestones[milestones.length - 1];

  // A brand-new install still produces one all-zero period; that is not history.
  if (accounts.length === 0 && milestones.length === 0) {
    return (
      <>
        <PageHeader title="History" description="Look back at how your money grew over time." />
        <EmptyState
          icon={HistoryIcon}
          title="No history yet"
          description={NO_DATA_DESCRIPTION}
          action={<ConnectDataActions />}
        />
      </>
    );
  }

  if (rows.length === 0) {
    // No synced history yet — the hand-recorded checkpoints carry the page.
    if (milestones.length === 0) {
      return (
        <>
          <PageHeader
            title="History"
            description="Look back at how your money grew over time."
          />
          <EmptyState
            icon={HistoryIcon}
            title="No history yet"
            description="Sync an account, or add a net worth checkpoint by hand to start the record."
          />
        </>
      );
    }

    const manualChartData = milestones.map((m) => ({
      date: m.date,
      net: m.totalCents,
    }));
    const latestManual = milestones[milestones.length - 1];
    const oldestManual = milestones[0];
    const manualChange = latestManual.totalCents - oldestManual.totalCents;

    return (
      <>
        <PageHeader
          title="History"
          description="Look back at how your money grew over time."
        >
          <RangeSelector
            options={PERIOD_OPTIONS}
            value={periodType}
            paramKey="period"
            defaultValue="month"
          />
        </PageHeader>
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Latest manual net worth"
            value={formatUSD(latestManual.totalCents)}
          />
          <StatCard
            label="Manual history change"
            value={`${manualChange >= 0 ? "+" : "−"}${formatUSD(Math.abs(manualChange))}`}
            accent={manualChange >= 0 ? "up" : "down"}
          />
          <StatCard
            label="Manual entries"
            value={String(milestones.length)}
            sub={`${formatDate(oldestManual.date)} to ${formatDate(latestManual.date)}`}
          />
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Manual net worth history</CardTitle>
          </CardHeader>
          <CardContent>
            <NetWorthChart data={manualChartData} />
          </CardContent>
        </Card>

        <ManualMilestonesCard milestoneRows={milestoneRows} latest={latestMilestone} />

        <EmptyState
          icon={HistoryIcon}
          title="No synced history yet"
          description="Once you've synced some accounts, your net worth by week and month will build up here."
        />
      </>
    );
  }

  const selectedKey = at && rows.some((r) => r.key === at) ? at : rows[0].key;
  const breakdown = await getPeriodBreakdown(periodType, selectedKey);

  // chart wants ascending end-of-period points
  const chartPoints = new Map<string, number>();
  for (const m of milestones) chartPoints.set(m.date, m.totalCents);
  for (const r of [...rows].reverse()) chartPoints.set(r.end, r.netWorthCents);
  const chartData = [...chartPoints.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, net]) => ({ date, net }));

  const latest = rows[0];
  const oldest = rows[rows.length - 1];
  const spanChange = latest.netWorthCents - oldest.netWorthCents;
  const totalSaved = rows.reduce((s, r) => s + r.savedCents, 0);

  const pq = periodType === "week" ? "period=week&" : "";
  const unit = periodType === "week" ? "weeks" : "months";

  return (
    <>
      <PageHeader
        title="History"
        description="Look back at how your money grew — and where it came from and went."
      >
        <RangeSelector
          options={PERIOD_OPTIONS}
          value={periodType}
          paramKey="period"
          defaultValue="month"
        />
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Net worth now" value={formatUSD(latest.netWorthCents)} />
        <StatCard
          label={`Change over ${rows.length} ${unit}`}
          value={`${spanChange >= 0 ? "+" : "−"}${formatUSD(Math.abs(spanChange))}`}
          accent={spanChange >= 0 ? "up" : "down"}
        />
        <StatCard
          label={`Saved across ${rows.length} ${unit}`}
          value={formatUSD(totalSaved)}
          accent={totalSaved >= 0 ? "up" : "down"}
          sub="income minus spending"
        />
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-3"><CardTitle className="text-base">Liquid money today</CardTitle><p className="text-muted-foreground text-sm">A current-day companion to your history: spendable balances only, with investments kept separate.</p></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div><div className="text-muted-foreground text-xs">Liquid assets</div><div className="mt-1 font-semibold tabular-nums">{formatUSD(liquidMoney.liquidAssetsCents)}</div></div>
          <div><div className="text-muted-foreground text-xs">Liabilities</div><div className="mt-1 font-semibold text-negative tabular-nums">{formatUSD(liquidMoney.liabilitiesCents)}</div></div>
          <div><div className="text-muted-foreground text-xs">Liquid after liabilities</div><div className={cn("mt-1 font-semibold tabular-nums", liquidMoney.liquidAfterLiabilitiesCents < 0 ? "text-negative" : "text-positive")}>{formatUSD(liquidMoney.liquidAfterLiabilitiesCents)}</div></div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">
            Net worth by {periodType === "week" ? "week" : "month"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NetWorthChart data={chartData} />
        </CardContent>
      </Card>

      <ManualMilestonesCard milestoneRows={milestoneRows} latest={latestMilestone} />

      <Card className="mb-6 py-0">
        <Table containerClassName="max-h-[70vh]">
          <TableHeader className="bg-card sticky top-0 z-10">
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Net worth</TableHead>
              <TableHead className="text-right">Change</TableHead>
              <TableHead className="text-right">Income</TableHead>
              <TableHead className="text-right">Retirement</TableHead>
              <TableHead className="text-right">Earned / invested</TableHead>
              <TableHead className="text-right">Spending</TableHead>
              <TableHead className="text-right">Saved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.key}
                className={cn(r.key === selectedKey && "bg-accent/40")}
              >
                <TableCell>
                  <Link
                    href={`/history?${pq}at=${r.key}`}
                    className="font-medium hover:underline"
                    scroll={false}
                  >
                    {r.label}
                  </Link>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatUSD(r.netWorthCents)}
                </TableCell>
                <TableCell className="text-right">
                  <ChangeCell cents={r.changeCents} pct={r.changePct} />
                </TableCell>
                <TableCell className="text-right tabular-nums text-positive">
                  {r.incomeCents ? formatUSD(r.incomeCents) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-info">
                  {r.retirementContributionCents ? formatUSD(r.retirementContributionCents) : "—"}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums text-positive">
                  {r.earnedAndInvestedCents ? formatUSD(r.earnedAndInvestedCents) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.spendingCents ? formatUSD(r.spendingCents) : "—"}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right font-medium tabular-nums",
                    r.savedCents < 0 && "text-negative",
                  )}
                >
                  {formatUSD(r.savedCents)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {breakdown && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Money in · {breakdown.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {breakdown.income.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No income recorded this {periodType}.
                </p>
              ) : (
                <div className="divide-y">
                  {breakdown.income.map((f) => (
                    <FlowRow key={f.name} f={f} goodWhenUp />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Money out · {breakdown.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {breakdown.spending.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No spending recorded this {periodType}.
                </p>
              ) : (
                <div className="divide-y">
                  {breakdown.spending.map((f) => (
                    <FlowRow key={f.name} f={f} goodWhenUp={false} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-muted-foreground mt-4 text-xs">
        Arrows compare each category to the previous {periodType}. History grows
        as you keep syncing — snapshots are saved daily.
      </p>
    </>
  );
}
