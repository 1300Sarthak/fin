"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { TriangleAlert } from "lucide-react";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  formatCompact,
  formatDate,
  formatDateShort,
  formatUSD,
} from "@/lib/format";
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
