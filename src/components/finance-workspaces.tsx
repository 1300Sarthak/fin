"use client";

import * as React from "react";
import Link from "next/link";
import { Area, AreaChart, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ArrowUpRight, Landmark } from "lucide-react";
import { TransactionDetailDialog } from "@/components/transaction-detail-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { chartColor } from "@/components/chart-palette";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatCompact, formatDateShort, formatSigned, formatUSD, monthLabel } from "@/lib/format";
import type { EarningsWorkspace, InvestmentActivity, InvestmentsWorkspace, PieSlice, TransfersWorkspace, WorkspaceTransaction } from "@/lib/workspaces";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const chartConfig = { value: { label: "Value", color: "var(--chart-2)" } } satisfies ChartConfig;

function Donut({ title, data, onSelect, selected }: { title: string; data: PieSlice[]; onSelect?: (id: string | undefined) => void; selected?: string }) {
  const still = useReducedMotion();
  return <Card className="min-w-0"><CardHeader className="pb-1"><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-[190px_1fr] sm:items-center">
    {data.length ? <ChartContainer config={chartConfig} className="mx-auto h-[190px] aspect-square w-full max-w-[190px]">
      <PieChart><ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" formatter={(value, name) => <span className="flex w-full items-center justify-between gap-4"><span className="text-muted-foreground">{name}</span><span className="font-medium tabular-nums">{formatUSD(Number(value) * 100)}</span></span>} />} /><Pie isAnimationActive={!still} data={data.map((row) => ({ ...row, value: row.valueCents / 100 }))} dataKey="value" nameKey="name" innerRadius={52} outerRadius={82} paddingAngle={2} onClick={(_, index) => onSelect?.(data[index]?.id)} className="cursor-pointer">
        {data.map((row, index) => <Cell key={row.id} fill={chartColor(index)} opacity={!selected || selected === row.id ? 1 : .35} />)}
      </Pie></PieChart>
    </ChartContainer> : <div className="text-muted-foreground grid h-[160px] place-items-center text-sm">No data yet</div>}
    <div className="max-h-52 space-y-1 overflow-auto pr-1">{data.map((row, index) => <button type="button" key={row.id} onClick={() => onSelect?.(selected === row.id ? undefined : row.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${selected === row.id ? "bg-muted" : ""}`}>
      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: chartColor(index) }} /><span className="min-w-0 flex-1 truncate">{row.name}</span><span className="tabular-nums">{formatUSD(row.valueCents)}</span>
    </button>)}</div>
  </CardContent></Card>;
}

function Trend({ title, data }: { title: string; data: { month: string; valueCents: number }[] }) {
  const still = useReducedMotion();
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent><ChartContainer config={chartConfig} className="h-[230px] w-full">
    <AreaChart data={data.map((row) => ({ ...row, value: row.valueCents / 100 }))} margin={{ left: 8, right: 8 }}><defs><linearGradient id="workspace-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--color-value)" stopOpacity={.45}/><stop offset="100%" stopColor="var(--color-value)" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="month" tickFormatter={(value) => value.length === 7 ? monthLabel(`${value}-01`) : value} tickLine={false} axisLine={false} /><YAxis tickFormatter={(value) => formatCompact(Number(value) * 100)} tickLine={false} axisLine={false} width={56}/><ChartTooltip content={<ChartTooltipContent labelFormatter={(label) => typeof label === "string" && label.length === 7 ? monthLabel(`${label}-01`) : String(label)} formatter={(value) => <span className="font-medium tabular-nums">{formatUSD(Number(value) * 100)}</span>} />} /><Area isAnimationActive={!still} dataKey="value" stroke="var(--color-value)" fill="url(#workspace-fill)" strokeWidth={2}/></AreaChart>
  </ChartContainer></CardContent></Card>;
}

function Activity({ rows, selectedSource, sourceByRow, empty = "Nothing to show yet.", title = "Activity" }: { rows: WorkspaceTransaction[]; selectedSource?: string; sourceByRow: (row: WorkspaceTransaction) => string; empty?: string; title?: string }) {
  const filtered = selectedSource ? rows.filter((row) => sourceByRow(row) === selectedSource) : rows;
  return <Card><CardHeader><CardTitle className="text-base">{title} {selectedSource ? "· filtered" : ""}</CardTitle></CardHeader><CardContent className="p-0">{filtered.length ? <Table containerClassName="max-h-[32rem]"><TableHeader className="sticky top-0 bg-card"><TableRow><TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead>Account</TableHead><TableHead className="hidden sm:table-cell">Category</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader><TableBody>{filtered.map((row) => <TableRow key={row.id}><TransactionDetailDialog txn={{ ...row, account: { id: row.accountId, name: row.accountName } as never, category: row.categoryId ? { id: row.categoryId, name: row.categoryName } as never : null, isPending: false, isRecurring: false, isTransfer: false, isExcluded: false, isRefund: false, refundsTxnId: null, transferPairTxnId: null, refundsTransaction: null, refundedBy: [], memo: null, note: null, payeeNormalized: "", categorySource: "", categoryConfidence: null, recurringSeriesId: null, source: "manual", externalId: null, createdAt: row.postedAt }} /><TableCell className="text-muted-foreground">{row.accountName}</TableCell><TableCell className="text-muted-foreground hidden sm:table-cell">{row.categoryName}</TableCell><TableCell className="text-right font-medium tabular-nums text-positive">{formatSigned(row.amountCents)}</TableCell></TableRow>)}</TableBody></Table> : <p className="text-muted-foreground py-8 text-center text-sm">{empty}</p>}</CardContent></Card>;
}

export function EarningsWorkspaceView({ data }: { data: EarningsWorkspace }) {
  const [source, setSource] = React.useState<string>(); const [account, setAccount] = React.useState<string>();
  const rows = data.transactions.filter((row) => (!source || String(row.categoryId ?? row.merchantRaw) === source) && (!account || String(row.accountId) === account));
  return <div className="space-y-6">
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Cash income this month" value={data.monthCents}/>
      <Metric label="Retirement deposited" value={data.monthRetirementContributionCents}/>
      <Metric label="Earned / invested this month" value={data.monthEarnedAndInvestedCents}/>
      <Metric label="All recorded cash income" value={data.totalCents}/>
    </div>
    <Card className="border-info/30 bg-info/5"><CardContent className="pt-6 text-sm text-muted-foreground"><strong className="text-foreground">{data.monthLabel}: cash income + retirement deposits.</strong> Retirement deposits are visible alongside earnings because they are money you put toward your future, but they stay separate from cash income to prevent a transfer from being counted twice. {data.retirementContributionCount ? `${data.retirementContributionCount} Roth IRA / 401(k) contribution${data.retirementContributionCount === 1 ? "" : "s"} (${formatUSD(data.retirementContributionCents)}) recorded across all months.` : "Retirement contributions will appear here when imported."} <Link href="/investments" className="ml-1 font-medium text-info hover:underline">View contribution details →</Link></CardContent></Card>
    <div className="grid gap-6 xl:grid-cols-2"><Donut title="Cash income by source" data={data.sources} selected={source} onSelect={setSource}/><Donut title="Where cash income lands" data={data.accounts} selected={account} onSelect={setAccount}/></div>
    <Trend title="Cash income over the last 6 months" data={data.trend}/>
    {data.contributions.length > 0 && <Activity title="Retirement deposits this month" rows={data.contributions} sourceByRow={() => ""} empty="No retirement deposits this month."/>}
    <Activity title="Cash income activity" rows={rows} sourceByRow={() => ""} empty="No cash income matches these selections."/>
  </div>;
}

function InvestmentActivityList({ rows }: { rows: InvestmentActivity[] }) {
  return <Card><CardHeader><CardTitle className="text-base">Investment activity</CardTitle></CardHeader><CardContent className="p-0">{rows.length ? <Table containerClassName="max-h-[34rem]"><TableHeader className="sticky top-0 bg-card"><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Description</TableHead><TableHead>Investment account</TableHead><TableHead className="hidden lg:table-cell">Money source</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.id}><TransactionDetailDialog txn={{ ...row, account: { id: row.accountId, name: row.accountName } as never, category: row.categoryId ? { id: row.categoryId, name: row.categoryName } as never : null, isPending: false, isRecurring: false, isTransfer: row.isInternalTransfer, isExcluded: false, isRefund: false, refundsTxnId: null, transferPairTxnId: null, refundsTransaction: null, refundedBy: [], memo: null, note: null, payeeNormalized: "", categorySource: "", categoryConfidence: null, recurringSeriesId: null, source: "manual", externalId: null, createdAt: row.postedAt }} /><TableCell><span className="rounded-full bg-muted px-2 py-1 text-xs font-medium">{row.activityLabel}</span></TableCell><TableCell className="max-w-[22ch] truncate font-medium">{row.merchantRaw}</TableCell><TableCell className="text-muted-foreground">{row.accountName}</TableCell><TableCell className="text-muted-foreground hidden lg:table-cell">{row.sourceAccountName ? `From ${row.sourceAccountName}` : row.activityKind === "contribution" ? "Not linked in import" : "—"}</TableCell><TableCell className={`text-right font-medium tabular-nums ${row.activityKind === "contribution" || row.activityKind === "investment_income" ? "text-positive" : ""}`}>{row.activityKind === "contribution" ? "+" : row.amountCents < 0 ? "-" : "+"}{formatUSD(row.displayAmountCents)}</TableCell></TableRow>)}</TableBody></Table> : <p className="text-muted-foreground py-8 text-center text-sm">No investment activity yet.</p>}</CardContent></Card>;
}

export function InvestmentsWorkspaceView({ data }: { data: InvestmentsWorkspace }) {
  const [accountId, setAccountId] = React.useState<string>(); const selected = data.accounts.find((account) => String(account.id) === accountId);
  const activity = selected ? selected.activity : data.activity;
  return <div className="space-y-6"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Investments" value={data.totalCents}/><Metric label="Contributions recorded" value={data.contributionCents}/><Metric label="Investment income" value={data.investmentIncomeCents}/><Metric label="Fees recorded" value={data.feeCents}/></div><Card className="border-positive/30 bg-positive/5"><CardContent className="pt-6 text-sm text-muted-foreground"><strong className="text-foreground">Contributions are deposits, not spending or earnings.</strong> They are displayed as positive saved amounts even when a brokerage feed uses a negative cash-leg sign. A linked funding account is shown below when the import provides one.</CardContent></Card><div className="grid gap-6 xl:grid-cols-2"><Donut title="Portfolio by account" data={data.accounts.map((account) => ({ id: String(account.id), name: account.name, valueCents: account.balanceCents }))} selected={accountId} onSelect={setAccountId}/><Donut title="Portfolio by account type" data={data.byType}/></div><Trend title="Recorded portfolio value" data={selected ? selected.snapshots.map((x) => ({ month: x.date, valueCents: x.valueCents })) : data.trend}/><Card><CardHeader><CardTitle className="text-base">{selected ? `${selected.name} selected` : "Choose an investment account"}</CardTitle></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.accounts.map((account) => <Button key={account.id} variant={String(account.id) === accountId ? "secondary" : "outline"} className="h-auto justify-between px-3 py-3" onClick={() => setAccountId(accountId === String(account.id) ? undefined : String(account.id))}><span className="min-w-0 truncate text-left"><span className="block">{account.name}</span><span className="text-muted-foreground block text-xs font-normal">{account.institution ?? account.type.toUpperCase()}</span></span><span className="tabular-nums">{formatUSD(account.balanceCents)}</span></Button>)}</div></CardContent></Card><InvestmentActivityList rows={activity}/></div>;
}

export function TransfersWorkspaceView({ data }: { data: TransfersWorkspace }) {
  const [account, setAccount] = React.useState<string>(); const rows = data.transfers.filter((row) => !account || String(row.accountId) === account || String(row.pairedAccountId) === account);
  return <div className="space-y-6"><div className="grid gap-4 sm:grid-cols-3"><Metric label="Moved between accounts" value={data.totalCents}/><Metric label="Matched transfers" value={data.matchedCount} raw/><Metric label="Needs review" value={data.unpairedCount} raw/></div><Card className="border-info/30 bg-info/5"><CardContent className="flex gap-3 pt-6 text-sm"><Landmark className="size-5 shrink-0 text-info"/><p><strong>Transfers never count as spending or income.</strong> A matched transfer is shown once below—even though both sides stay in your ledger—so paying a card or moving money between accounts cannot double-count.</p></CardContent></Card><Donut title="Transfer volume by origin account" data={data.accounts} selected={account} onSelect={setAccount}/><Card><CardHeader><CardTitle className="text-base">Transfer activity</CardTitle></CardHeader><CardContent>{rows.length ? <div className="divide-y">{rows.map((row) => <div key={row.id} className="flex items-center gap-3 py-3"><span className="bg-info/10 grid size-9 place-items-center rounded-full text-info"><ArrowUpRight className="size-4"/></span><div className="min-w-0 flex-1"><div className="font-medium">{row.accountName}{row.pairedAccountName ? ` → ${row.pairedAccountName}` : ""}</div><div className="text-muted-foreground truncate text-xs">{formatDateShort(row.postedAt)} · {row.merchantRaw || "Internal transfer"} · {row.isManualPair ? "paired" : "single-side classification"}</div></div><span className="font-medium tabular-nums">{formatUSD(Math.abs(row.amountCents))}</span></div>)}</div> : <p className="text-muted-foreground py-8 text-center text-sm">No transfers match this account.</p>}</CardContent></Card></div>;
}

function Metric({ label, value, raw = false }: { label: string; value: number; raw?: boolean }) {
  return <StatCard label={label} value={raw ? value.toLocaleString("en-US") : formatUSD(value)} />;
}
