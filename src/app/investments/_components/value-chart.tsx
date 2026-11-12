"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatCompact, formatDateShort, formatUSD } from "@/lib/format";

const config = { value: { label: "Portfolio value", color: "var(--chart-1)" } } satisfies ChartConfig;

/** Recorded portfolio value, one point per day every investment account had a snapshot. Cents in. */
export function ValueChart({ data }: { data: { date: string; valueCents: number }[] }) {
  const still = useReducedMotion();
  return (
    <ChartContainer config={config} className="h-[240px] w-full">
      <AreaChart data={data.map((d) => ({ date: d.date, value: d.valueCents / 100 }))} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillPortfolio" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={(v) => formatDateShort(v as string)} />
        <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatCompact(Number(v) * 100)} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => formatDateShort(v as string)} formatter={(value) => <span className="font-medium tabular-nums">{formatUSD(Number(value) * 100)}</span>} />} />
        <Area isAnimationActive={!still} dataKey="value" type="monotone" stroke="var(--color-value)" fill="url(#fillPortfolio)" strokeWidth={2} />
      </AreaChart>
    </ChartContainer>
  );
}
