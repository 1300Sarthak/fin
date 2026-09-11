"use client";

import { Area, AreaChart, CartesianGrid, ReferenceArea, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCompact, formatUSD, formatDateShort } from "@/lib/format";
import { useReducedMotion } from "@/components/use-reduced-motion";

const config = {
  net: { label: "Net worth", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function NetWorthChart({
  data,
  realFrom,
}: {
  data: { date: string; net: number }[];
  /** Days before this date are transaction-reconstructed (shaded as estimated). */
  realFrom?: string | null;
}) {
  const still = useReducedMotion();
  // chart works in dollars; DB stores cents
  const chartData = data.map((d) => ({ date: d.date, net: d.net / 100 }));
  const showPartial = !!realFrom && data.length > 0 && data[0].date < realFrom;

  return (
    <ChartContainer config={config} className="h-[260px] w-full">
      <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillNet" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-net)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-net)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        {showPartial && (
          <ReferenceArea
            x1={data[0].date}
            x2={realFrom}
            fill="var(--muted-foreground)"
            fillOpacity={0.06}
          />
        )}
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
        <Area
          isAnimationActive={!still}
          dataKey="net"
          type="monotone"
          stroke="var(--color-net)"
          fill="url(#fillNet)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
