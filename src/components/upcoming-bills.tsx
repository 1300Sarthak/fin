"use client";

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { addWeeks, parseISO, startOfWeek } from "date-fns";
import { ChevronDown, TriangleAlert } from "lucide-react";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  formatCompact,
  formatDate,
  formatDateShort,
  formatUSD,
  isoDate,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/use-reduced-motion";

/** Dates cross the server/client boundary as `yyyy-MM-dd` so both sides agree. */
export type UpcomingBillView = {
  seriesId: number;
  name: string;
  cadence: string;
  status: string;
  amountCents: number;
  expectedAmountCents: number;
  dueAt: string;
  daysAway: number;
  isLate: boolean;
};

export type LowBalanceView = {
  thresholdCents: number;
  triggered: boolean;
  date: string | null;
  daysAway: number | null;
  balanceCents: number;
  shortfallCents: number;
  minBalanceCents: number;
  minDate: string;
};

const CADENCE_LABEL: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

function dueLabel(daysAway: number) {
  if (daysAway <= 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  return `in ${daysAway} days`;
}

/* --------------------------------- bill list ---------------------------------- */

type Week = { key: string; label: string; bills: UpcomingBillView[]; totalCents: number };

function groupByWeek(bills: UpcomingBillView[], todayISO: string): Week[] {
  const thisWeek = isoDate(startOfWeek(parseISO(todayISO)));
  const nextWeek = isoDate(addWeeks(parseISO(thisWeek), 1));

  const weeks = new Map<string, Week>();
  for (const b of bills) {
    const key = isoDate(startOfWeek(parseISO(b.dueAt)));
    const week =
      weeks.get(key) ??
      weeks
        .set(key, {
          key,
          label:
            key === thisWeek
              ? "This week"
              : key === nextWeek
                ? "Next week"
                : `Week of ${formatDateShort(key)}`,
          bills: [],
          totalCents: 0,
        })
        .get(key)!;
    week.bills.push(b);
    week.totalCents += b.amountCents;
  }
  return [...weeks.values()];
}

export function UpcomingBills({
  bills,
  warning,
  todayISO,
}: {
  bills: UpcomingBillView[];
  warning: LowBalanceView;
  todayISO: string;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const weeks = groupByWeek(bills, todayISO);

  const toggle = (key: string) =>
    setCollapsed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));

  return (
    <div className="space-y-4">
      {warning.triggered && <LowBalanceBanner warning={warning} />}

      {weeks.map((w) => {
        const isCollapsed = collapsed.includes(w.key);
        return (
          <Card key={w.key} className="gap-0 py-0">
            <button
              type="button"
              onClick={() => toggle(w.key)}
              aria-expanded={!isCollapsed}
              className="hover:bg-muted/50 flex w-full items-center gap-2 px-4 py-3 text-left transition-colors"
            >
              <ChevronDown
                className={cn(
                  "text-muted-foreground size-4 transition-transform",
                  isCollapsed && "-rotate-90",
                )}
              />
              <span className="text-sm font-medium">{w.label}</span>
              <span className="text-muted-foreground text-xs">
                {w.bills.length} {w.bills.length === 1 ? "bill" : "bills"}
              </span>
              <span className="ml-auto text-sm font-medium tabular-nums">
                {formatUSD(w.totalCents)}
              </span>
            </button>

            {!isCollapsed && (
              <div className="divide-y border-t">
                {w.bills.map((b) => {
                  const bump = b.amountCents - b.expectedAmountCents;
                  return (
                    <div
                      key={`${b.seriesId}-${b.dueAt}`}
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{b.name}</span>
                          <Badge variant="outline" className="text-muted-foreground">
                            {CADENCE_LABEL[b.cadence] ?? b.cadence}
                          </Badge>
                          {/* A day or two of slip is normal; only badge the ones
                              recurring.ts already considers missed. */}
                          {b.isLate && b.status === "missed" && (
                            <Badge
                              variant="outline"
                              className="border-warning/40 bg-warning/10 text-warning"
                            >
                              Late — estimated
                            </Badge>
                          )}
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-xs">
                          {formatDate(b.dueAt)} · {dueLabel(b.daysAway)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium tabular-nums">
                          {formatUSD(b.amountCents)}
                        </div>
                        {b.status === "price_changed" && bump > 0 && (
                          <div className="text-xs text-negative tabular-nums">
                            +{formatUSD(bump)} vs usual
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/* ------------------------------ low-balance banner ----------------------------- */

export function LowBalanceBanner({ warning }: { warning: LowBalanceView }) {
  const when =
    warning.daysAway === 0
      ? "today"
      : warning.daysAway === 1
        ? "tomorrow"
        : `in ${warning.daysAway} days`;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-negative/40 bg-negative/10 p-4"
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-negative" />
      <div className="text-sm">
        <div className="font-medium text-negative">
          Projected to drop below {formatUSD(warning.thresholdCents, false)}{" "}
          {when}
        </div>
        <p className="text-muted-foreground mt-1">
          Upcoming bills bottom out at{" "}
          <span className="tabular-nums">{formatUSD(warning.minBalanceCents)}</span>{" "}
          on {formatDate(warning.minDate)}
          {warning.shortfallCents > 0 && (
            <>
              {" "}
              — {formatUSD(warning.shortfallCents)} under your cushion
            </>
          )}
          . Move cash over or pause something before then.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------- forecast chart -------------------------------- */

const chartConfig = {
  balance: { label: "Projected balance", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function BalanceForecastChart({
  data,
  thresholdCents,
}: {
  data: { date: string; balanceCents: number }[];
  thresholdCents: number;
}) {
  const still = useReducedMotion();
  // chart works in dollars; DB stores cents
  const chartData = data.map((d) => ({
    date: d.date,
    balance: d.balanceCents / 100,
  }));

  return (
    <ChartContainer config={chartConfig} className="h-[260px] w-full">
      <LineChart data={chartData} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={40}
          tickFormatter={(v) => formatDateShort(v as string)}
        />
        <YAxis
          domain={["auto", "auto"]}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => formatCompact(Number(v) * 100)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => formatDateShort(v as string)}
              formatter={(value) => (
                <span className="font-medium tabular-nums">
                  {formatUSD(Number(value) * 100)}
                </span>
              )}
            />
          }
        />
        <ReferenceLine
          y={thresholdCents / 100}
          stroke="var(--chart-4)"
          strokeDasharray="4 4"
          label={{
            value: `Low: ${formatUSD(thresholdCents, false)}`,
            position: "insideTopLeft",
            fill: "var(--muted-foreground)",
            fontSize: 11,
          }}
        />
        <Line
          isAnimationActive={!still}
          dataKey="balance"
          type="stepAfter"
          stroke="var(--color-balance)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
