"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/kit";
import { CategoryIcon } from "@/components/spending-category-icon";
import { BudgetGroupEditor, type EditorCategory, type EditorGroup } from "@/components/budget-group-editor";
import { txnHref } from "@/components/spending-links";
import { formatUSD } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BudgetGroupsReport } from "@/lib/budget-groups";
import { paceLabel } from "@/lib/budget-groups-core";

const TONE = { "on-track": "bg-foreground/70", "over-pace": "bg-warning", over: "bg-negative" } as const;

/**
 * Budget groups for one month: a bar per group with a tick where a straight-
 * line month would be today. Rows open to the categories behind them, each a
 * link to its transactions.
 */
export function BudgetGroupsPanel({ report, categories, account }: {
  report: BudgetGroupsReport;
  categories: EditorCategory[];
  account?: number;
}) {
  const [open, setOpen] = React.useState<number | null>(null);
  // Kept after close so the dialog's title doesn't flip while it animates out.
  const [editing, setEditingGroup] = React.useState<EditorGroup | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const setEditing = (g: EditorGroup | null) => { setEditingGroup(g); setEditorOpen(true); };
  const [grown, setGrown] = React.useState(false);
  React.useEffect(() => { const id = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(id); }, []);

  const groups: EditorGroup[] = report.groups.map((g) => ({ id: g.id, name: g.name, limitCents: g.limitCents, categoryIds: g.configuredCategoryIds, catchAll: g.catchAll }));
  const parentName = new Map(categories.map((c) => [c.id, c.parentId == null ? undefined : categories.find((p) => p.id === c.parentId)?.name]));
  const { clock, total } = report;

  return (
    <Section
      title="Budgets"
      description={report.groups.length
        // Budgets are monthly: the page passes the month the picked range ends in.
        ? `${report.label} · budgets are monthly${clock.daysElapsed > 0 && clock.daysElapsed < clock.daysInMonth ? `, day ${clock.daysElapsed} of ${clock.daysInMonth}` : ""}. ${formatUSD(total.spentCents)} of ${formatUSD(total.limitCents)} spent.`
        : "Set a monthly limit for a few categories, and one for everything else."}
      actions={<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditing(null)}><Plus className="size-3.5" />New budget</Button>}
      surface
    >
      {report.groups.length === 0 && report.legacy.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-medium">No budgets yet</p>
          <p className="text-muted-foreground mt-1 text-[13px]">Try Food at $500 a month, and Everything else for the rest.</p>
          <Button size="sm" className="mt-4" onClick={() => setEditing(null)}><Plus className="size-3.5" />New budget</Button>
        </div>
      ) : (
        <ul className="divide-y">
          {report.groups.map((g) => {
            const expanded = open === g.id;
            const fill = Math.min(g.pct, 1) * 100;
            return (
              <li key={g.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : g.id)}
                  className="hoverable w-full px-4 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{g.name}</span>
                      <ChevronDown className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform duration-200 ease-[var(--ease-out)] motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
                    </span>
                    <span className="num shrink-0 text-sm">
                      <span className={cn("font-medium", g.status === "over" && "text-negative")}>{formatUSD(g.spentCents)}</span>
                      <span className="text-muted-foreground"> of {formatUSD(g.limitCents, false)}</span>
                    </span>
                  </span>
                  <span className="bg-muted relative mt-2.5 block h-2 rounded-full" aria-hidden="true">
                    <span className="absolute inset-0 overflow-hidden rounded-full">
                      <span
                        className={cn("block h-full origin-left rounded-full transition-transform duration-500 ease-[var(--ease-out)] motion-reduce:transition-none", TONE[g.status])}
                        style={{ width: `${fill}%`, transform: `scaleX(${grown ? 1 : 0})` }}
                      />
                    </span>
                    {clock.daysElapsed > 0 && clock.daysElapsed < clock.daysInMonth && (
                      <span className="bg-foreground absolute -top-1 -bottom-1 w-0.5 rounded-full" style={{ left: `calc(${g.paceFraction * 100}% - 1px)` }} title="Where a steady month would be today" />
                    )}
                  </span>
                  <span className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-xs">
                    <span className="text-muted-foreground num">
                      {g.remainingCents < 0
                        ? <span className="text-negative">Over by {formatUSD(-g.remainingCents)}</span>
                        : <>{formatUSD(g.remainingCents)} left{g.perDayRemainingCents != null && <>, {formatUSD(g.perDayRemainingCents)} a day for {g.daysRemaining} {g.daysRemaining === 1 ? "day" : "days"}</>}</>}
                    </span>
                    <span className={cn("num", g.status === "on-track" ? "text-muted-foreground" : g.status === "over-pace" ? "text-warning" : "text-negative")}>
                      {paceLabel(g, formatUSD)}
                      <span className="text-muted-foreground">, heading for {formatUSD(g.projectedCents)}</span>
                    </span>
                  </span>
                </button>
                {expanded && (
                  <div className="drop-in px-4 pb-4 md:px-5">
                    {g.categories.length === 0 ? (
                      <p className="text-muted-foreground py-2 text-[13px]">Nothing spent in this budget yet.</p>
                    ) : (
                      <ul className="bg-muted/40 divide-y rounded-lg">
                        {g.categories.map((c) => (
                          <li key={c.categoryId ?? "none"}>
                            <Link
                              href={txnHref({ from: report.from, to: report.to, category: c.name, kind: "expense", account })}
                              className="hoverable flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <CategoryIcon name={c.name} parent={c.categoryId == null ? undefined : parentName.get(c.categoryId)} className="size-7" />
                              <span className="min-w-0 flex-1 truncate">{c.name}</span>
                              <span className="num">{formatUSD(c.spentCents)}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs">
                        {g.catchAll ? "Everything no other budget covers, uncategorized included." : `${g.categoryIds.length} ${g.categoryIds.length === 1 ? "category" : "categories"}`}
                      </span>
                      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditing(groups.find((x) => x.id === g.id) ?? null)}>
                        <Pencil className="size-3.5" />Edit
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {report.legacy.map((b) => (
            <li key={`legacy-${b.id}`}>
              <Link href={txnHref({ from: report.from, to: report.to, category: b.name, kind: "expense", account })} className="hoverable block px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{b.name} <span className="text-muted-foreground text-xs font-normal">category budget</span></span>
                  <span className="num"><span className={cn("font-medium", b.pct >= 1 && "text-negative")}>{formatUSD(b.spentCents)}</span><span className="text-muted-foreground"> of {formatUSD(b.limitCents, false)}</span></span>
                </span>
                <span className="bg-muted mt-2.5 block h-2 overflow-hidden rounded-full" aria-hidden="true">
                  <span className={cn("block h-full rounded-full", b.pct >= 1 ? "bg-negative" : b.pct >= 0.8 ? "bg-warning" : "bg-foreground/70")} style={{ width: `${Math.min(100, b.pct * 100)}%` }} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <BudgetGroupEditor open={editorOpen} onOpenChange={setEditorOpen} group={editing} groups={groups} categories={categories} />
    </Section>
  );
}
