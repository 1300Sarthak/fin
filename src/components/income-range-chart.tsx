"use client";

import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatCompact, formatUSD } from "@/lib/format";

export type IncomeChartSeries = { key: string; label: string; color: string };
export type IncomeChartPeriod = { label: string; short: string; href: string; values: Record<string, number> };

/**
 * Income stacked by job, one bar per period. Values arrive in cents. A bar is a
 * link: clicking it opens the money in behind that period.
 */
export function IncomeRangeChart({ series, periods }: { series: IncomeChartSeries[]; periods: IncomeChartPeriod[] }) {
  const still = useReducedMotion();
  const router = useRouter();
  // Source names are user text; chart keys become CSS variables, so key by index.
  const config = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;
  const data = periods.map((p) => ({ label: p.label, short: p.short, ...Object.fromEntries(series.map((s) => [s.key, (p.values[s.key] ?? 0) / 100])) }));
  const open = (index: number | undefined) => { if (index != null && periods[index]) router.push(periods[index].href); };
  return (
    <ChartContainer config={config} className="h-[260px] w-full md:h-[300px]">
      <BarChart data={data} margin={{ left: 4, right: 4, top: 8 }} onClick={(state) => open(state?.activeTooltipIndex == null ? undefined : Number(state.activeTooltipIndex))} className="[&_.recharts-bar-rectangle]:cursor-pointer">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="short" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={12} />
        <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(v) => formatCompact(Number(v) * 100)} />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(_, payload) => String(payload?.[0]?.payload?.label ?? "")} formatter={(value, name) => (
          <span className="flex w-full items-center justify-between gap-4"><span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span><span className="num font-medium">{formatUSD(Math.round(Number(value) * 100))}</span></span>
        )} />} />
        {series.map((s, i) => (
          <Bar key={s.key} isAnimationActive={!still} animationDuration={500} dataKey={s.key} stackId="income" fill={`var(--color-${s.key})`} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
