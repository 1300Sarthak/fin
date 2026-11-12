"use client";

import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatCompact, formatUSD, monthLabel } from "@/lib/format";
import { txnHref } from "@/components/spending-links";
import type { CashflowBucket } from "@/lib/spending-summary";

const config = {
  income: { label: "Made", color: "var(--chart-2)" },
  expense: { label: "Spent", color: "var(--chart-4)" },
} satisfies ChartConfig;

/**
 * Money in and out by month. Months outside the picked range stay as quiet
 * context; clicking a bar opens that month's transactions of that kind.
 */
export function SpendingFlowChart({ data, account }: { data: CashflowBucket[]; account?: number }) {
  const router = useRouter();
  const still = useReducedMotion();
  const rows = data.map((d) => ({ ...d, income: d.income / 100, expense: d.expense / 100 }));
  const open = (kind: "income" | "expense") => (_: unknown, index: number) => {
    const b = data[index];
    if (b) router.push(txnHref({ from: b.from, to: b.to, kind, account }));
  };

  return (
    <ChartContainer config={config} className="aspect-auto h-[200px] w-full md:h-[220px]">
      <BarChart data={rows} margin={{ left: 0, right: 4, top: 8 }} barGap={3} barCategoryGap="22%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} minTickGap={8} tickFormatter={(v) => monthLabel(`${v}-01`).slice(0, 3)} />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v) => formatCompact(Number(v) * 100)} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={
            <ChartTooltipContent
              labelFormatter={(v) => monthLabel(`${v}-01`)}
              formatter={(value, name) => (
                <span className="flex w-full items-center justify-between gap-4">
                  <span className="text-muted-foreground">{name === "income" ? "Made" : "Spent"}</span>
                  <span className="font-medium tabular-nums">{formatUSD(Number(value) * 100)}</span>
                </span>
              )}
            />
          }
        />
        {(["income", "expense"] as const).map((key) => (
          <Bar key={key} isAnimationActive={!still} dataKey={key} fill={`var(--color-${key})`} radius={[3, 3, 0, 0]} maxBarSize={22} className="cursor-pointer" onClick={open(key)}>
            {rows.map((r) => <Cell key={r.month} fillOpacity={r.inRange ? 1 : 0.28} />)}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  );
}
