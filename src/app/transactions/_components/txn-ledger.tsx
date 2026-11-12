"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dataTable, Money } from "@/components/kit";
import { format } from "date-fns";
import { isoDate } from "@/lib/format";
import type { SelectCategory } from "@/lib/queries";
import type { FilteredTxn } from "@/lib/txn-filter";
import { cn } from "@/lib/utils";
import { TxnDrawer } from "./txn-drawer";
import { TxnFlags } from "./txn-flags";

type Key = "date" | "description" | "category" | "account" | "amount";
const VALUE: Record<Key, (t: FilteredTxn) => string | number> = {
  date: (t) => t.postedAt.getTime(),
  description: (t) => t.merchantRaw.toLowerCase(),
  category: (t) => (t.category?.name ?? "~").toLowerCase(),
  account: (t) => (t.account?.name ?? "").toLowerCase(),
  amount: (t) => t.amountCents,
};
const THIS_YEAR = new Date().getFullYear();
const when = (d: Date) => format(d, d.getFullYear() === THIS_YEAR ? "MMM d" : "MMM d, yyyy");

const COLUMNS: { key: Key; label: string; className?: string }[] = [
  { key: "date", label: "Date", className: "w-24" },
  { key: "description", label: "Description" },
  { key: "category", label: "Category" },
  { key: "account", label: "Account" },
  { key: "amount", label: "Amount", className: dataTable.num },
];

/** Category as a link that narrows the list to it, keeping the dates. */
function CategoryLink({ t, className }: { t: FilteredTxn; className?: string }) {
  const params = useSearchParams();
  const name = t.category?.name ?? "Uncategorized";
  const next = new URLSearchParams(params.toString());
  next.set("category", name);
  next.delete("limit");
  return (
    <Link
      href={`/transactions?${next}`}
      onClick={(e) => e.stopPropagation()}
      className={cn("hover:text-foreground hover:underline underline-offset-2", !t.category && "text-warning", className)}
      title={`Only ${name}`}
    >
      {name}
    </Link>
  );
}

export function TxnLedger({ rows, categories }: { rows: FilteredTxn[]; categories: SelectCategory[] }) {
  const [sort, setSort] = React.useState<{ key: Key; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });
  // The selected row stays set while the sheet animates closed.
  const [sel, setSel] = React.useState<{ id: number | null; open: boolean }>({ id: null, open: false });
  const openId = sel.open ? sel.id : null;
  const setOpenId = (id: number) => setSel({ id, open: true });
  const sorted = React.useMemo(() => {
    const read = VALUE[sort.key];
    const sign = sort.dir === "asc" ? 1 : -1;
    return rows.toSorted((a, b) => {
      const x = read(a);
      const y = read(b);
      return x === y ? b.id - a.id : (x > y ? 1 : -1) * sign;
    });
  }, [rows, sort]);
  const selected = rows.find((r) => r.id === sel.id) ?? null;
  const toggle = (key: Key) => setSort((c) => (c.key === key ? { key, dir: c.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "date" || key === "amount" ? "desc" : "asc" }));

  return (
    <>
      {/* Phones: a stacked list, newest first, same rows and drawer. */}
      <ul className="bg-card divide-y overflow-hidden rounded-xl border md:hidden">
        {sorted.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setOpenId(t.id)} className="hoverable flex w-full items-start gap-3 px-4 py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t.merchantRaw || "Transaction"}</span>
                <span className="text-muted-foreground block truncate text-xs">{when(t.postedAt)} · {t.category?.name ?? "Uncategorized"} · {t.account?.name}</span>
              </span>
              <Money cents={t.amountCents} signed tone={t.amountCents > 0 ? "positive" : "none"} className={cn("shrink-0 text-sm font-medium", (t.isTransfer || t.isExcluded) && "opacity-60")} />
            </button>
          </li>
        ))}
      </ul>

      <div className={cn(dataTable.shell, "hidden md:block")}>
        <Table containerClassName="max-h-[calc(100vh-12rem)]">
          <TableHeader className={dataTable.stickyHead}>
            <TableRow>
              {COLUMNS.map((c) => {
                const active = sort.key === c.key;
                const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
                return (
                  <TableHead key={c.key} className={cn(dataTable.edge, c.className)} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => toggle(c.key)} className={cn("hover:text-foreground inline-flex items-center gap-1", active && "text-foreground")}>
                      {c.label}
                      <Icon className={cn("size-3", !active && "opacity-50")} aria-hidden="true" />
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((t) => (
              <TableRow
                key={t.id}
                onClick={() => setOpenId(t.id)}
                className={cn(dataTable.clickableRow, "hoverable", openId === t.id && "bg-brand/5")}
              >
                <TableCell className={cn(dataTable.edge, dataTable.meta, "num whitespace-nowrap")}>
                  <time dateTime={isoDate(t.postedAt)}>{when(t.postedAt)}</time>
                </TableCell>
                <TableCell className="max-w-[36ch]">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setOpenId(t.id); }}
                    className="max-w-full truncate text-left font-medium outline-none focus-visible:underline"
                    aria-label={`Details for ${t.merchantRaw || "transaction"} on ${when(t.postedAt)}`}
                  >
                    {t.merchantRaw || "Transaction"}
                  </button>
                  <TxnFlags t={t} />
                </TableCell>
                <TableCell className="text-muted-foreground text-[13px] whitespace-nowrap"><CategoryLink t={t} /></TableCell>
                <TableCell className="text-muted-foreground max-w-[20ch] truncate text-[13px]">{t.account?.name ?? "—"}</TableCell>
                <TableCell className={cn(dataTable.edge, dataTable.num, "font-medium whitespace-nowrap", (t.isTransfer || t.isExcluded) && "opacity-60")}>
                  <Money cents={t.amountCents} signed tone={t.amountCents > 0 ? "positive" : "none"} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <TxnDrawer txn={selected} open={sel.open} categories={categories} onOpenChange={(next) => setSel((s) => ({ ...s, open: next }))} />
    </>
  );
}
