"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Disclosure, Field, Money, Section, Segmented, Stat, StatGroup, StickyActions, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatUSD } from "@/lib/format";
import { dateForMilestone, projectFuturePlan, SCENARIOS, valueAtDate, type FuturePlanInputs } from "@/lib/future-plan-core";

const chartConfig = { netWorth: { label: "Projected net worth", color: "var(--chart-1)" } } satisfies ChartConfig;
const formatDate = (date: string | null) => date ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)) : "Beyond 50 years";
const money = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const MILESTONES = [50000, 100000, 250000, 500000, 1000000];

function NumberField({ id, label, value, onChange, suffix, min = 0, step = 1, help }: { id: string; label: string; value: number; onChange: (v: number) => void; suffix?: string; min?: number; step?: number; help?: string }) {
  return <Field label={label} htmlFor={id} help={help}>
    <div className="relative">
      <input id={id} className={cn(inputClass, "num", suffix && "pr-14")} type="number" inputMode="decimal" min={min} step={step} value={value} onChange={(e) => onChange(money(Number(e.target.value)))} />
      {suffix && <span className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">{suffix}</span>}
    </div>
  </Field>;
}

function DateField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return <Field label={label} htmlFor={id}><input id={id} className={cn(inputClass, "num")} type="date" value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
}

/** A what-if projection of net worth. Saved to config `future_plan`; never touches balances or transactions. */
export function FuturePlanWorkspace({ initialPlan }: { initialPlan: FuturePlanInputs }) {
  const [plan, setPlan] = React.useState(initialPlan);
  const [saved, setSaved] = React.useState(initialPlan);
  const [saving, setSaving] = React.useState(false);
  const still = useReducedMotion();
  const dirty = JSON.stringify(plan) !== JSON.stringify(saved);
  const update = <K extends keyof FuturePlanInputs>(key: K, value: FuturePlanInputs[K]) => setPlan((old) => ({ ...old, [key]: value }));
  const series = React.useMemo(() => projectFuturePlan(plan), [plan]);
  const goalValue = React.useMemo(() => valueAtDate(plan, plan.goalDate), [plan]);
  const milestones = React.useMemo(() => MILESTONES.map((value) => ({ value, date: dateForMilestone(plan, value) })), [plan]);
  const monthly = plan.annualContribution * SCENARIOS[plan.scenario].contributionMultiplier / 12;
  const effectiveReturn = plan.annualReturn + SCENARIOS[plan.scenario].returnAdjustment;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ futurePlan: plan }) });
      const data = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Could not save plan");
      setSaved(plan);
      toast.success("Future plan saved");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save plan"); }
    finally { setSaving(false); }
  }

  return <form onSubmit={save} className="space-y-10">
    <StatGroup cols={3}>
      <Stat size="lg" className="col-span-2 lg:col-span-1" label="At your goal date" value={<Money cents={Math.round(goalValue * 100)} wholeDollars />} sub={`${formatDate(plan.goalDate)} · ${SCENARIOS[plan.scenario].label.toLowerCase()}`} />
      <Stat label="Planned monthly addition" value={<Money cents={Math.round(monthly * 100)} wholeDollars />} sub="Before market movement" />
      <Stat label="Model return" value={`${effectiveReturn.toFixed(1)}%`} sub="Annual, scenario-adjusted" />
    </StatGroup>

    <div className="grid gap-x-8 gap-y-10 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Section title="Plan assumptions" description="Editable estimates, not promises." surface bodyClassName="space-y-5 p-5 md:p-6" className="min-w-0">
        <div className="space-y-2" role="group" aria-labelledby="fp-scenario">
          <span id="fp-scenario" className="text-[13px] font-medium">Scenario</span>
          <Segmented aria-label="Scenario" className="w-full" options={(Object.keys(SCENARIOS) as FuturePlanInputs["scenario"][]).map((s) => ({ value: s, label: SCENARIOS[s].label }))} value={plan.scenario} onValueChange={(v) => update("scenario", v)} />
        </div>
        <NumberField id="fp-networth" label="Current net worth" value={plan.netWorth} onChange={(v) => update("netWorth", v)} suffix="USD" min={-10000000} />
        <NumberField id="fp-contribution" label="Annual wealth creation" value={plan.annualContribution} onChange={(v) => update("annualContribution", v)} suffix="USD/yr" help="An assumption you control. Personal spending is not subtracted from it again." />
        <NumberField id="fp-return" label="Expected annual return" value={plan.annualReturn} onChange={(v) => update("annualReturn", v)} suffix="%" min={0} step={0.1} />
        <DateField id="fp-goal" label="Goal date" value={plan.goalDate} onChange={(v) => update("goalDate", v)} />
        <Disclosure summary="Start dates and spending" className="border-t pt-3">
          <div className="space-y-5 pt-1">
            <NumberField id="fp-spending" label="Personal spending" value={plan.annualSpending} onChange={(v) => update("annualSpending", v)} suffix="USD/yr" help="Shown to keep the plan grounded, not subtracted again from wealth creation." />
            <div className="grid grid-cols-2 gap-3">
              <DateField id="fp-start" label="Start date" value={plan.startDate} onChange={(v) => update("startDate", v)} />
              <DateField id="fp-fulltime" label="Full-time start" value={plan.fullTimeStart} onChange={(v) => update("fullTimeStart", v)} />
            </div>
          </div>
        </Disclosure>
      </Section>

      <div className="min-w-0 space-y-10">
        {/* min-w-0: a recharts container inside an auto grid track grows without it. */}
        <Section title="Projected net worth" description={`Quarterly model through ${series.at(-1)?.label}. Contributions are applied monthly; returns are hypothetical.`} surface bodyClassName="p-3 pt-5 md:p-5" className="min-w-0">
          <ChartContainer config={chartConfig} className="h-[260px] w-full md:h-[310px]">
            <AreaChart data={series} margin={{ top: 12, left: 4, right: 10 }}>
              <defs><linearGradient id="future-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--color-netWorth)" stopOpacity={0.28} /><stop offset="95%" stopColor="var(--color-netWorth)" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={35} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
              <ReferenceLine y={plan.netWorth} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
              <ChartTooltip content={<ChartTooltipContent formatter={(value) => <span className="font-medium tabular-nums">{formatUSD(Math.round(Number(value) * 100))}</span>} />} />
              <Area isAnimationActive={!still} dataKey="netWorth" name="Projected net worth" type="monotone" stroke="var(--color-netWorth)" fill="url(#future-fill)" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        </Section>

        <Section title="Milestone path" description="Dates move immediately with your assumptions." surface>
          <ol className="divide-y">
            {milestones.map(({ value, date }) => <li key={value} className="flex items-center justify-between gap-3 px-4 py-3 text-sm md:px-5">
              <Money cents={value * 100} wholeDollars className="font-medium" />
              <span className={cn("num", date ? "text-foreground" : "text-muted-foreground")}>{formatDate(date)}</span>
            </li>)}
          </ol>
        </Section>
      </div>
    </div>

    <Disclosure summary="Planning estimate only" hint="What this model does not do">
      <p className="text-muted-foreground max-w-[80ch] text-[13px] leading-relaxed">This page does not predict investment returns, taxes, compensation, or expenses. Annual wealth creation is an assumption you control; personal spending is shown to keep the plan grounded, not subtracted again from that assumption. Your actual balances and transaction analytics are never changed.</p>
    </Disclosure>

    <StickyActions show={dirty || saving} message="Unsaved assumptions. The projection updates as you type.">
      <Button type="button" variant="ghost" size="sm" onClick={() => setPlan(saved)} disabled={saving}>Discard</Button>
      <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save plan"}</Button>
    </StickyActions>
  </form>;
}
