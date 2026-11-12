"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import { Segmented, Section, dataTable } from "@/components/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TransactionDetailDialog } from "@/components/transaction-detail-dialog";
import { chartColor } from "@/components/chart-palette";
import { CategoryIcon } from "@/components/spending-category-icon";
import { txnHref, type TxnLink } from "@/components/spending-links";
import { formatDateShort, formatPct, formatUSD, isoDate } from "@/lib/format";
import { shortAccountName } from "@/lib/account-label";
import { cn } from "@/lib/utils";
import type { SelectCategory } from "@/lib/queries";
import type { SpendingTransaction } from "@/lib/spending";

export type BreakdownItem = {
  id: string;
  name: string;
  /** Parent category, or account kind — one quiet word of context. */
  context?: string;
  spentCents: number;
  refundedCents?: number;
  count: number;
  link: TxnLink;
};

type View = "category" | "card" | "merchant";
const VIEWS = [
  { value: "category", label: "Category" },
  { value: "card", label: "Card" },
  { value: "merchant", label: "Merchant" },
] as const;
const ROW_LIMIT = 150;
const LIST_LIMIT = 10;
/** Phones show a short list; the rest is one tap away in Transactions. */
const PHONE_LIMIT = 20;
const dayOf = (d: Date | string) => isoDate(d);
/** Card rows and account cells use the short "Robinhood ••7531" form. */
const label = (view: View, name: string) => (view === "card" ? shortAccountName(name) : name);

/**
 * Where the money went, three ways. Picking a row filters the purchases beside
 * it in place, and the same selection opens in Transactions with exact filters.
 */
export function SpendingBreakdown({ items, transactions, categories, range, totalCents, initial }: {
  items: Record<View, BreakdownItem[]>;
  transactions: SpendingTransaction[];
  categories: SelectCategory[];
  range: { from: string; to: string; account?: number };
  totalCents: number;
  initial?: { view: View; id: string };
}) {
  const [view, setView] = React.useState<View>(initial?.view ?? "category");
  const [selected, setSelected] = React.useState<string | undefined>(initial?.id);
  const [showAll, setShowAll] = React.useState(false);
  const list = items[view];
  const visible = showAll ? list : list.slice(0, LIST_LIMIT);
  const pick = list.find((i) => i.id === selected);

  const match = React.useCallback((t: SpendingTransaction) => {
    if (!pick) return true;
    if (view === "category") return String(t.categoryId ?? "none") === pick.id;
    if (view === "card") return String(t.accountId) === pick.id;
    return t.merchantRaw === pick.id;
  }, [pick, view]);
  const rows = React.useMemo(() => transactions.filter(match), [transactions, match]);
  const net = rows.reduce((s, t) => s + t.netSpentCents, 0);
  const base: TxnLink = { from: range.from, to: range.to, kind: "expense", account: range.account };
  const href = txnHref(pick ? { ...base, ...pick.link } : base);
  const max = Math.max(1, ...list.map((i) => i.spentCents));
  const positive = list.filter((i) => i.spentCents > 0);
  const stripTotal = positive.reduce((s, i) => s + i.spentCents, 0) || 1;

  return (
    <Section
      title="Where it went"
      description={`${formatUSD(totalCents)} across ${transactions.filter((t) => t.amountCents < 0).length} purchases. Pick a row to see what's behind it.`}
      actions={<Segmented aria-label="Break down by" options={VIEWS} value={view} onValueChange={(v) => { setView(v); setSelected(undefined); setShowAll(false); }} />}
      surface
    >
      <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0 lg:border-r">
          {positive.length > 0 && (
            <div className="px-4 pt-4 md:px-5 md:pt-5" aria-hidden="true">
              <div className="flex h-2 gap-px overflow-hidden rounded-full">
                {positive.map((i, n) => (
                  <span
                    key={i.id}
                    className={cn("h-full transition-opacity duration-200", selected && selected !== i.id && "opacity-30")}
                    style={{ width: `${(i.spentCents / stripTotal) * 100}%`, backgroundColor: chartColor(n) }}
                  />
                ))}
              </div>
            </div>
          )}
          {list.length === 0 ? (
            <p className="text-muted-foreground px-5 py-10 text-center text-sm">No spending in this period.</p>
          ) : (
            <ul className="stagger p-2 md:p-3" aria-label={`Spending by ${view}`}>
              {visible.map((item) => {
                const active = item.id === selected;
                const share = totalCents > 0 ? item.spentCents / totalCents : 0;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelected(active ? undefined : item.id)}
                      className={cn(
                        "hoverable group w-full rounded-lg px-2.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active && "bg-brand/10 hover:bg-brand/10",
                      )}
                    >
                      <span className="flex items-start gap-3">
                        {view === "category" ? (
                          <CategoryIcon name={item.name} parent={item.context} />
                        ) : (
                          <span className="grid size-8 shrink-0 place-items-center" aria-hidden="true">
                            <span className="size-2 rounded-full" style={{ backgroundColor: item.spentCents > 0 ? chartColor(positive.indexOf(item)) : "var(--muted-foreground)" }} />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium break-words" title={view === "card" ? item.name : undefined}>{label(view, item.name)}</span>
                          <span className="text-muted-foreground block text-xs">
                            {item.context ? `${item.context}, ` : ""}{item.count} {item.count === 1 ? "purchase" : "purchases"}
                            {item.refundedCents ? `, ${formatUSD(item.refundedCents)} refunded` : ""}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="num block text-sm font-medium">{item.spentCents < 0 ? `−${formatUSD(-item.spentCents)}` : formatUSD(item.spentCents)}</span>
                          <span className="num text-muted-foreground block text-xs">{formatPct(share)}</span>
                        </span>
                      </span>
                      <span className="bg-muted mt-2 ml-11 block h-1 overflow-hidden rounded-full" aria-hidden="true">
                        <span
                          className="block h-full rounded-full transition-[width] duration-500 ease-[var(--ease-out)] motion-reduce:transition-none"
                          style={{ width: `${Math.max(0, item.spentCents / max) * 100}%`, backgroundColor: item.spentCents > 0 ? chartColor(positive.indexOf(item)) : undefined }}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
              {list.length > LIST_LIMIT && (
                <li>
                  <button type="button" onClick={() => setShowAll((v) => !v)} className="hoverable text-muted-foreground hover:text-foreground mt-1 flex min-h-11 w-full items-center justify-center rounded-lg text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {showAll ? "Show fewer" : `Show ${list.length - LIST_LIMIT} more`}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="min-w-0 border-t lg:flex lg:flex-col lg:border-t-0">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3.5 md:px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <span className="truncate">{pick ? label(view, pick.name) : "All purchases"}</span>
                {pick && (
                  <button type="button" onClick={() => setSelected(undefined)} className="text-muted-foreground hover:text-foreground rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Clear selection">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="text-muted-foreground num text-xs">
                {rows.length} {rows.length === 1 ? "row" : "rows"}, {net < 0 ? "net refund " : "net "}{formatUSD(Math.abs(net))}
              </div>
            </div>
            <Link href={href} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Open in Transactions <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground border-t px-5 py-10 text-center text-sm">No purchases match.</p>
          ) : (
            <>
            <ul className="divide-y border-t md:hidden">
              {rows.slice(0, PHONE_LIMIT).map((t) => (
                <li key={t.id}>
                  <Link
                    href={txnHref({ q: t.merchantRaw, from: dayOf(t.postedAt), to: dayOf(t.postedAt), account: t.accountId })}
                    className="hoverable flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{t.merchantRaw || "Transaction"}{t.isPending && <span className="text-muted-foreground font-normal"> (pending)</span>}</span>
                      <span className="text-muted-foreground block truncate text-xs">{formatDateShort(t.postedAt)}, {view === "category" ? (t.account ? shortAccountName(t.account.name) : "—") : t.category?.name ?? "Uncategorized"}</span>
                    </span>
                    <span className="text-right">
                      <span className="num block text-sm font-medium">{t.netSpentCents < 0 ? `−${formatUSD(-t.netSpentCents)}` : formatUSD(t.netSpentCents)}</span>
                      {t.refundedCents > 0 && <span className="num text-positive block text-[11px]">−{formatUSD(t.refundedCents)} refund</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Table containerClassName="hidden max-h-[34rem] border-t md:block lg:max-h-none lg:min-h-[20rem] lg:flex-1 lg:basis-0">
              <TableHeader className={dataTable.stickyHead}>
                <TableRow>
                  <TableHead className={cn("w-20", dataTable.edge)}>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead className="hidden md:table-cell">{view === "category" ? "Card" : "Category"}</TableHead>
                  <TableHead className={cn(dataTable.num, dataTable.edge)}>Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, ROW_LIMIT).map((t) => (
                  <TableRow key={t.id} className="[&>td:first-child]:pl-4 md:[&>td:first-child]:pl-5">
                    <TransactionDetailDialog txn={t} categories={categories} />
                    <TableCell className="text-muted-foreground hidden max-w-[16rem] truncate md:table-cell">
                      {view === "category" ? (t.account ? shortAccountName(t.account.name) : "—") : t.category?.name ?? "Uncategorized"}
                    </TableCell>
                    <TableCell className={cn(dataTable.num, dataTable.edge, "font-medium")}>
                      {t.netSpentCents < 0 ? `−${formatUSD(-t.netSpentCents)}` : formatUSD(t.netSpentCents)}
                      {t.refundedCents > 0 && <span className="text-positive block text-[11px] font-normal">−{formatUSD(t.refundedCents)} refund</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </>
          )}
          {rows.length > PHONE_LIMIT && (
            <Link href={href} className="hoverable text-muted-foreground flex min-h-12 items-center justify-center border-t text-[13px] font-medium md:hidden">
              See all {rows.length} in Transactions
            </Link>
          )}
          {rows.length > ROW_LIMIT && (
            <p className="text-muted-foreground hidden border-t px-5 py-3 text-xs md:block">
              Showing the latest {ROW_LIMIT}. <Link href={href} className="text-foreground underline-offset-2 hover:underline">See all {rows.length} in Transactions</Link>
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
