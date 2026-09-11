"use client";

import * as React from "react";
import { Pie, PieChart, Cell } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransactionDetailDialog } from "@/components/transaction-detail-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { chartColor } from "@/components/chart-palette";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatPct, formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SelectCategory } from "@/lib/queries";
import type { SpendingTransaction } from "@/lib/spending";

type Breakdown = { id: string; name: string; spentCents: number; count: number; pct?: number };
const DONUT_CONFIG = { spentCents: { label: "Spent" } } satisfies ChartConfig;

/** A compact, coordinated explorer built from the server's reconciled month. */
export function SpendingExplorer({ categories, cards, transactions, categoriesForSelect, initialCategoryId }: {
  categories: Breakdown[];
  cards: Breakdown[];
  transactions: SpendingTransaction[];
  categoriesForSelect: SelectCategory[];
  initialCategoryId?: string;
}) {
  const [categoryId, setCategoryId] = React.useState<string | undefined>(initialCategoryId);
  const [cardId, setCardId] = React.useState<string | undefined>();
  const selectedCategory = categories.find((item) => item.id === categoryId);
  const selectedCard = cards.find((item) => item.id === cardId);
  const selectedTransactions = React.useMemo(() => transactions.filter((transaction) =>
    (!categoryId || String(transaction.categoryId ?? "none") === categoryId) &&
    (!cardId || String(transaction.accountId) === cardId)), [transactions, categoryId, cardId]);
  const net = selectedTransactions.reduce((sum, item) => sum + item.netSpentCents, 0);
  const title = [selectedCategory?.name, selectedCard?.name].filter(Boolean).join(" · ");

  return <section aria-labelledby="spending-breakdown-title" className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 id="spending-breakdown-title" className="font-heading text-lg font-semibold">Where it went</h2><p className="text-muted-foreground mt-1 text-sm">Choose a slice or legend to inspect purchases instantly.</p></div>
      {(categoryId || cardId) && <Button variant="ghost" size="sm" onClick={() => { setCategoryId(undefined); setCardId(undefined); }}><X className="size-3.5" /> Clear selection</Button>}
    </div>
    <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(15rem,1fr)_minmax(15rem,1fr)_minmax(23rem,1.25fr)]">
      <DonutPanel heading="By category" items={categories} selectedId={categoryId} onSelect={(id) => setCategoryId((current) => current === id ? undefined : id)} showShare />
      <DonutPanel heading="By card" items={cards} selectedId={cardId} onSelect={(id) => setCardId((current) => current === id ? undefined : id)} />
      <ActivityPanel transactions={selectedTransactions} title={title || "All spending activity"} net={net} categories={categoriesForSelect} />
    </div>
  </section>;
}

function DonutPanel({ heading, items, selectedId, onSelect, showShare = false }: { heading: string; items: Breakdown[]; selectedId?: string; onSelect: (id: string) => void; showShare?: boolean }) {
  const still = useReducedMotion();
  const positive = items.filter((item) => item.spentCents > 0);
  const total = positive.reduce((sum, item) => sum + item.spentCents, 0);
  const selected = items.find((item) => item.id === selectedId);
  return <article className="min-w-0 rounded-xl border bg-background/40 p-4 shadow-sm">
    <div className="flex items-baseline justify-between gap-3"><div><h3 className="font-medium">{heading}</h3><p className="text-muted-foreground text-xs">{heading === "By card" ? "Payment source" : "Purchase purpose"}</p></div><span className="text-sm font-semibold tabular-nums">{formatUSD(total)}</span></div>
    {positive.length ? <><div className="relative mx-auto mt-2 h-52 max-w-[18rem]" aria-label={`${heading} spending chart`}>
      <ChartContainer config={DONUT_CONFIG} className="aspect-auto h-full w-full"><PieChart><ChartTooltip content={<ChartTooltipContent hideLabel nameKey="name" formatter={(value, name) => <span className="flex w-full items-center justify-between gap-4"><span className="text-muted-foreground">{name}</span><span className="font-medium tabular-nums">{formatUSD(Number(value))}</span></span>} />} /><Pie isAnimationActive={!still} data={positive} dataKey="spentCents" nameKey="name" cx="50%" cy="50%" innerRadius="57%" outerRadius="82%" paddingAngle={2} stroke="transparent" onClick={(_, index) => onSelect(positive[index].id)} className="cursor-pointer outline-none">{positive.map((item, index) => <Cell key={item.id} fill={chartColor(index)} opacity={!selectedId || item.id === selectedId ? 1 : .35} className="transition-opacity duration-200 motion-reduce:transition-none" />)}</Pie></PieChart></ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"><span className="text-muted-foreground text-[11px]">{selected?.name ?? "Total"}</span><strong className="max-w-28 truncate text-base tabular-nums">{formatUSD(selected?.spentCents ?? total)}</strong></div>
    </div><ul className="max-h-52 space-y-0.5 overflow-y-auto pr-1" aria-label={`${heading} legend`}>{items.map((item, index) => <li key={item.id}><button type="button" onClick={() => onSelect(item.id)} aria-pressed={item.id === selectedId} className={cn("flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", item.id === selectedId && "bg-muted ring-1 ring-primary/40")}><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: chartColor(index) }} aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{item.name}</span><span className="shrink-0 tabular-nums">{formatUSD(item.spentCents)}</span>{showShare && item.pct != null && <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">{formatPct(item.pct)}</span>}</button></li>)}</ul></> : <p className="text-muted-foreground flex h-64 items-center justify-center text-sm">No positive spending to chart.</p>}
  </article>;
}

function ActivityPanel({ transactions, title, net, categories }: { transactions: SpendingTransaction[]; title: string; net: number; categories: SelectCategory[] }) {
  return <article className="min-w-0 overflow-hidden rounded-xl border bg-background/40 shadow-sm"><div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3"><div><h3 className="font-medium">{title}</h3><p className="text-muted-foreground text-xs">{transactions.length} {transactions.length === 1 ? "purchase" : "purchases"} · click one for details</p></div><span className="text-sm font-semibold tabular-nums">{net < 0 ? "Net refund " : "Net spend "}{formatUSD(Math.abs(net))}</span></div>
    {transactions.length === 0 ? <p className="text-muted-foreground flex h-80 items-center justify-center px-4 text-sm">No purchases match this combination.</p> : <Table containerClassName="h-[30.25rem]"><TableHeader className="sticky top-0 z-10 bg-card"><TableRow><TableHead className="w-20">Date</TableHead><TableHead>Merchant</TableHead><TableHead className="hidden md:table-cell">Category</TableHead><TableHead className="hidden lg:table-cell">Card</TableHead><TableHead className="text-right">Net</TableHead></TableRow></TableHeader><TableBody>{transactions.map((transaction) => <TableRow key={transaction.id}><TransactionDetailDialog txn={transaction} categories={categories} /><TableCell className="min-w-28 text-muted-foreground"><span className="hidden md:inline">{transaction.category?.name ?? "Uncategorized"}</span><span className="md:hidden">{transaction.refundedCents > 0 ? `Refunded ${formatUSD(transaction.refundedCents)}` : `Charge ${formatUSD(Math.abs(transaction.amountCents))}`}</span></TableCell><TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{transaction.account?.name ?? "—"}</TableCell><TableCell className="text-right font-medium tabular-nums"><span>{transaction.netSpentCents < 0 ? `−${formatUSD(-transaction.netSpentCents)}` : formatUSD(transaction.netSpentCents)}</span>{transaction.refundedCents > 0 && <span className="block text-[10px] font-normal text-positive">−{formatUSD(transaction.refundedCents)} refund</span>}</TableCell></TableRow>)}</TableBody></Table>}
  </article>;
}
