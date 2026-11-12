"use client";

import * as React from "react";
import Link from "next/link";
import { addWeeks, parseISO, startOfWeek } from "date-fns";
import { CalendarClock, ChevronDown } from "lucide-react";
import { Section } from "@/components/kit";
import { txnHref } from "@/components/spending-links";
import type { UpcomingBillView } from "@/components/upcoming-bills";
import { formatDate, formatDateShort, formatUSD, isoDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const CADENCE: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const due = (d: number) => (d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

type Week = { key: string; label: string; bills: UpcomingBillView[]; totalCents: number };

function weeksOf(bills: UpcomingBillView[], todayISO: string): Week[] {
  const thisWeek = isoDate(startOfWeek(parseISO(todayISO)));
  const nextWeek = isoDate(addWeeks(parseISO(thisWeek), 1));
  const out = new Map<string, Week>();
  for (const b of bills) {
    const key = isoDate(startOfWeek(parseISO(b.dueAt)));
    if (!out.has(key)) {
      out.set(key, { key, label: key === thisWeek ? "This week" : key === nextWeek ? "Next week" : `Week of ${formatDateShort(key)}`, bills: [], totalCents: 0 });
    }
    const w = out.get(key)!;
    w.bills.push(b);
    w.totalCents += b.amountCents;
  }
  return [...out.values()];
}

/** Bills grouped by week, one surface, each week collapsible; every bill opens its past charges. */
export function BillWeeks({ bills, todayISO }: { bills: UpcomingBillView[]; todayISO: string }) {
  const [closed, setClosed] = React.useState<string[]>([]);
  const weeks = weeksOf(bills, todayISO);
  return (
    <Section title="Bills" description={`${bills.length} expected, grouped by week.`} surface>
      <div className="divide-y">
        {weeks.map((w) => {
          const shut = closed.includes(w.key);
          return (
            <div key={w.key}>
              <button
                type="button"
                aria-expanded={!shut}
                onClick={() => setClosed((c) => (shut ? c.filter((k) => k !== w.key) : [...c, w.key]))}
                className="hoverable flex min-h-12 w-full items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5"
              >
                <ChevronDown className={cn("text-muted-foreground size-3.5 transition-transform duration-200 motion-reduce:transition-none", shut && "-rotate-90")} aria-hidden="true" />
                <span className="text-[13px] font-semibold">{w.label}</span>
                <span className="text-muted-foreground text-xs">{w.bills.length} {w.bills.length === 1 ? "bill" : "bills"}</span>
                <span className="num ml-auto text-[13px] font-medium">{formatUSD(w.totalCents)}</span>
              </button>
              {!shut && (
                <ul className="divide-y border-t border-dashed">
                  {w.bills.map((b) => {
                    const bump = b.amountCents - b.expectedAmountCents;
                    return (
                      <li key={`${b.seriesId}-${b.dueAt}`}>
                        <Link href={txnHref({ q: b.name })} className="hoverable flex min-h-14 items-center gap-3 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                          <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg" aria-hidden="true">
                            <CalendarClock className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="truncate text-sm font-medium">{b.name}</span>
                              {b.isLate && b.status === "missed" && (
                                <span className="border-warning/40 text-warning rounded-full border px-2 py-px text-[11px] font-medium">Late, estimated</span>
                              )}
                            </span>
                            <span className="text-muted-foreground block text-xs">
                              {formatDate(b.dueAt)}, {due(b.daysAway)}, {(CADENCE[b.cadence] ?? b.cadence).toLowerCase()}
                            </span>
                          </span>
                          <span className="text-right">
                            <span className="num block text-sm font-medium">{formatUSD(b.amountCents)}</span>
                            {b.status === "price_changed" && bump > 0 && <span className="num text-negative block text-xs">+{formatUSD(bump)} vs usual</span>}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
