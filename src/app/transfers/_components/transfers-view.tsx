"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, X } from "lucide-react";
import { Money, Section, dataTable } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateShort, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TransferRow = {
  id: number; day: string; accountId: number; accountName: string; description: string; amountCents: number;
  pairedAccountId: number | null; pairedAccountName: string | null; paired: boolean;
  /** /transactions filtered to this leg's account and day. */
  href: string;
};
export type TransferAccount = { id: number; name: string; valueCents: number; count: number; href: string };

/** Transfer list plus volume by origin account; picking an account filters the list to transfers touching it. */
export function TransfersView({ rows, accounts, rangeLabel }: { rows: TransferRow[]; accounts: TransferAccount[]; rangeLabel: string }) {
  const router = useRouter();
  const [account, setAccount] = React.useState<number | null>(null);
  const shown = account == null ? rows : rows.filter((r) => r.accountId === account || r.pairedAccountId === account);
  const picked = accounts.find((a) => a.id === account);
  const max = accounts[0]?.valueCents || 1;

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-8">
      <Section
        title="Transfer activity"
        description={picked ? `${pluralize(shown.length, "transfer")} touching ${picked.name}` : `${pluralize(rows.length, "transfer")} in ${rangeLabel.toLowerCase()}, paired legs shown once`}
        actions={picked && <Button size="sm" variant="ghost" onClick={() => setAccount(null)}><X /> Clear filter</Button>}
        className="order-2 min-w-0 lg:order-1"
      >
        {shown.length ? (
          <div className={dataTable.shell}>
            <Table containerClassName="max-h-[40rem]">
              <TableHeader className={dataTable.stickyHead}>
                <TableRow>
                  <TableHead className={dataTable.edge}>Date</TableHead>
                  <TableHead>From → to</TableHead>
                  <TableHead className="hidden md:table-cell">Description</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className={cn(dataTable.num, dataTable.edge)}>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={r.id} className={cn(dataTable.clickableRow, "hoverable")} onClick={() => router.push(r.href)}>
                    <TableCell className={cn(dataTable.edge, "text-muted-foreground whitespace-nowrap")}>{formatDateShort(r.day)}</TableCell>
                    <TableCell className="max-w-[11rem] sm:max-w-[22rem]">
                      <Link href={r.href} onClick={(e) => e.stopPropagation()} className="block truncate font-medium outline-none focus-visible:underline">
                        {r.accountName}{r.pairedAccountName && <><ArrowRight className="text-muted-foreground mx-1 inline size-3.5" aria-label="to" />{r.pairedAccountName}</>}
                      </Link>
                      <span className={cn(dataTable.meta, "block truncate md:hidden")}>{r.description}{r.paired ? "" : " · needs review"}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-[16rem] truncate md:table-cell">{r.description}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {r.paired
                        ? <span className="text-muted-foreground text-xs">Paired</span>
                        : <span className="text-muted-foreground text-xs">Single side</span>}
                    </TableCell>
                    <TableCell className={cn(dataTable.num, dataTable.edge, "font-medium")}><Money cents={Math.abs(r.amountCents)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-5 text-sm">No transfers match this account in this period.</p>
        )}
      </Section>

      <Section title="By origin account" description="Volume each account sent or received. Pick one to filter." className="order-1 min-w-0 lg:order-2" surface>
        {accounts.length ? (
          <ul className="stagger divide-y">
            {accounts.map((a) => {
              const on = account === a.id;
              return (
                <li key={a.id} className={cn("flex items-center gap-2 pr-2", on && "bg-brand/10")}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setAccount(on ? null : a.id)}
                    className="hoverable min-w-0 flex-1 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring md:px-5"
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={cn("truncate text-sm font-medium", on && "text-brand")}>{a.name}</span>
                      <Money cents={a.valueCents} className="shrink-0 text-sm font-medium" />
                    </span>
                    <span className="mt-1.5 flex items-center gap-3">
                      <span className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
                        <span className="bg-info block h-full rounded-full" style={{ width: `${Math.max(2, (a.valueCents / max) * 100)}%` }} />
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">{pluralize(a.count, "transfer")}</span>
                    </span>
                  </button>
                  <Link href={a.href} aria-label={`${a.name}: open transfers in transactions`} className="text-muted-foreground hover:text-foreground grid size-8 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ArrowUpRight className="size-4" />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : <p className="text-muted-foreground px-5 py-5 text-sm">No transfers in this period.</p>}
      </Section>
    </div>
  );
}
