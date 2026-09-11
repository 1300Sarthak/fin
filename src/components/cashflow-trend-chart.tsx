"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatCompact, formatUSD, monthLabel } from "@/lib/format";
import { useReducedMotion } from "@/components/use-reduced-motion";

const config = {
  income: { label: "Income", color: "var(--chart-2)" },
  expense: { label: "Spending", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function CashflowTrendChart({
  data,
}: {
  data: { month: string; income: number; expense: number }[];
}) {
  const still = useReducedMotion();
  const chartData = data.map((d) => ({
    month: d.month,
    income: d.income / 100,
    expense: d.expense / 100,
  }));

  return (
    <ChartContainer config={config} className="h-[240px] w-full">
      <BarChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => monthLabel(`${v}-01`)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v) => formatCompact(Number(v) * 100)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => monthLabel(`${v}-01`)}
              formatter={(value) => (
                <span className="font-medium tabular-nums">
                  {formatUSD(Number(value) * 100)}
                </span>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar isAnimationActive={!still} dataKey="income" fill="var(--color-income)" radius={4} />
        <Bar isAnimationActive={!still} dataKey="expense" fill="var(--color-expense)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
