"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TransactionDetailDialog } from "@/components/transaction-detail-dialog";
import { CategorySelect } from "@/components/category-select";
import { formatSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { getTransactions, SelectCategory } from "@/lib/queries";

type Txn = Awaited<ReturnType<typeof getTransactions>>[number];
type Key = "date" | "description" | "account" | "amount";

const VALUE: Record<Key, (t: Txn) => string | number> = {
  date: (t) => t.postedAt.getTime(),
  description: (t) => t.merchantRaw.toLowerCase(),
  account: (t) => (t.account?.name ?? "").toLowerCase(),
  amount: (t) => t.amountCents,
};

const COLUMNS: { key: Key | null; label: string; className?: string }[] = [
  { key: "date", label: "Date", className: "w-20" },
  { key: "description", label: "Description" },
  { key: "account", label: "Account" },
  { key: null, label: "Category" },
  { key: "amount", label: "Amount", className: "text-right" },
];

/** Client-side sort over the rows the server already sent — no refetch, no URL churn. */
export function TransactionsTable({ rows, categories }: { rows: Txn[]; categories: SelectCategory[] }) {
  const [sort, setSort] = React.useState<{ key: Key; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });

  const sorted = React.useMemo(() => {
    const read = VALUE[sort.key];
    const sign = sort.dir === "asc" ? 1 : -1;
    return rows.toSorted((a, b) => {
      const x = read(a);
      const y = read(b);
      if (x === y) return a.id - b.id; // stable tiebreak so re-sorts never shuffle
      return (x > y ? 1 : -1) * sign;
    });
  }, [rows, sort]);

  const toggle = (key: Key) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "description" || key === "account" ? "asc" : "desc" },
    );

  return (
    <Table containerClassName="max-h-[calc(100vh-13rem)]">
      <TableHeader className="bg-card sticky top-0 z-10">
        <TableRow>
          {COLUMNS.map((column) => {
            const key = column.key;
            if (!key) return <TableHead key={column.label}>{column.label}</TableHead>;
            const active = sort.key === key;
            const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
            return (
              <TableHead
                key={key}
                className={cn("p-0", column.className)}
                aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              >
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  className={cn(
                    "hover:text-foreground flex h-10 w-full items-center gap-1 px-2 font-medium",
                    column.className?.includes("text-right") && "justify-end",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {column.label}
                  <Icon className="size-3" aria-hidden="true" />
                </button>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((t) => (
          <TableRow key={t.id}>
            <TransactionDetailDialog txn={t} />
            <TableCell className="text-muted-foreground whitespace-nowrap">
              {t.account?.name ?? "—"}
            </TableCell>
            <TableCell>
              <CategorySelect txnId={t.id} value={t.categoryId} categories={categories} />
            </TableCell>
            <TableCell
              className={cn(
                "text-right font-medium tabular-nums whitespace-nowrap",
                t.amountCents >= 0 && "text-positive",
              )}
            >
              {formatSigned(t.amountCents)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
