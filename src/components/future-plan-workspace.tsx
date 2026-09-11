"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { Save, ShieldCheck, Sparkles, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatUSD } from "@/lib/format";
import { dateForMilestone, projectFuturePlan, SCENARIOS, valueAtDate, type FuturePlanInputs } from "@/lib/future-plan-core";

const chartConfig = { netWorth: { label: "Projected net worth", color: "var(--chart-1)" } } satisfies ChartConfig;
const formatDate = (date: string | null) => date ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)) : "Beyond 50 years";
const money = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

function Field({ label, value, onChange, suffix, min = 0, step = 1 }: { label: string; value: number; onChange: (v: number) => void; suffix?: string; min?: number; step?: number }) {
  const id = React.useId();
  return <div className="space-y-1.5"><Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label><div className="relative"><Input id={id} type="number" inputMode="decimal" min={min} step={step} value={value} onChange={(e) => onChange(money(Number(e.target.value)))} className="h-11 pr-12 tabular-nums" />{suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{suffix}</span>}</div></div>;
}

/** Dates are not money, so they skip Field but still need a bound label. */
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = React.useId();
  return <div className="space-y-1.5"><Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label><Input id={id} className="h-11" type="date" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
}

export function FuturePlanWorkspace({ initialPlan }: { initialPlan: FuturePlanInputs }) {
  const [plan, setPlan] = React.useState(initialPlan);
  const [saving, setSaving] = React.useState(false);
  const still = useReducedMotion();
  const update = <K extends keyof FuturePlanInputs>(key: K, value: FuturePlanInputs[K]) => setPlan((old) => ({ ...old, [key]: value }));
  const series = React.useMemo(() => projectFuturePlan(plan), [plan]);
  const goalValue = React.useMemo(() => valueAtDate(plan, plan.goalDate), [plan]);
  const milestones = React.useMemo(() => [50000, 100000, 250000, 500000, 1000000].map((value) => ({ value, date: dateForMilestone(plan, value) })), [plan]);
  const monthly = plan.annualContribution * SCENARIOS[plan.scenario].contributionMultiplier / 12;
  const effectiveReturn = plan.annualReturn + SCENARIOS[plan.scenario].returnAdjustment;
  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ futurePlan: plan }) });
      const data = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Could not save plan");
      toast.success("Future plan saved");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save plan"); }
    finally { setSaving(false); }
  }
  return <div className="space-y-6">
    <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/15 via-background to-positive/10 p-5 md:p-7">
      <div className="relative flex flex-wrap items-start justify-between gap-5"><div className="max-w-2xl"><div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary"><Sparkles className="size-4" /> Your wealth-building runway</div><h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Make the full-time years intentional.</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">A private what-if model for your goals. Change the assumptions, compare scenarios, and save the plan—your actual balances and transaction analytics are never changed.</p></div><Button onClick={save} disabled={saving} className="min-h-11 gap-2"><Save className="size-4" />{saving ? "Saving…" : "Save plan"}</Button></div>
    </section>
    <div className="grid gap-6 xl:grid-cols-[330px_minmax(0,1fr)]">
      {/* min-w-0: a recharts container inside an auto grid track grows without it. */}
      <Card className="h-fit min-w-0"><CardHeader><CardTitle className="text-base">Plan assumptions</CardTitle><CardDescription>Editable estimates, not promises.</CardDescription></CardHeader><CardContent className="space-y-4">
        <Field label="Current net worth" value={plan.netWorth} onChange={(v) => update("netWorth", v)} suffix="USD" min={-10000000} />
        <Field label="Annual wealth creation" value={plan.annualContribution} onChange={(v) => update("annualContribution", v)} suffix="USD/yr" />
        <Field label="Personal spending" value={plan.annualSpending} onChange={(v) => update("annualSpending", v)} suffix="USD/yr" />
        <Field label="Expected annual return" value={plan.annualReturn} onChange={(v) => update("annualReturn", v)} suffix="%" min={0} step={0.1} />
        <div className="grid grid-cols-2 gap-3"><DateField label="Start date" value={plan.startDate} onChange={(v) => update("startDate", v)} /><DateField label="Goal date" value={plan.goalDate} onChange={(v) => update("goalDate", v)} /></div>
        <DateField label="Full-time start" value={plan.fullTimeStart} onChange={(v) => update("fullTimeStart", v)} />
        <div className="space-y-2" role="group" aria-label="Scenario"><span className="text-muted-foreground text-xs font-medium">Scenario</span><div className="grid grid-cols-3 gap-1.5">{(Object.keys(SCENARIOS) as FuturePlanInputs["scenario"][]).map((scenario) => <button type="button" key={scenario} onClick={() => update("scenario", scenario)} className={cn("min-h-11 rounded-lg border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", plan.scenario === scenario ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>{SCENARIOS[scenario].label}</button>)}</div></div>
      </CardContent></Card>
      <div className="min-w-0 space-y-6"><div className="grid gap-4 sm:grid-cols-3"><StatCard label="At your goal date" value={formatUSD(Math.round(goalValue * 100))} sub={`${formatDate(plan.goalDate)} · ${SCENARIOS[plan.scenario].label.toLowerCase()}`} /><StatCard label="Planned monthly addition" value={formatUSD(Math.round(monthly * 100))} sub="before market movement" /><StatCard label="Model return" value={`${effectiveReturn.toFixed(1)}%`} sub="annual, scenario-adjusted" /></div>
        <Card><CardHeader><CardTitle className="text-base">Projected net worth</CardTitle><CardDescription>Quarterly model through {series.at(-1)?.label}. Contributions are applied monthly; returns are hypothetical.</CardDescription></CardHeader><CardContent><ChartContainer config={chartConfig} className="h-[310px] w-full"><AreaChart data={series} margin={{ top: 12, left: 8, right: 10 }}><defs><linearGradient id="future-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--color-netWorth)" stopOpacity={0.32} /><stop offset="95%" stopColor="var(--color-netWorth)" stopOpacity={0} /></linearGradient></defs><CartesianGrid vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={35} /><YAxis tickLine={false} axisLine={false} width={62} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} /><ReferenceLine y={plan.netWorth} stroke="var(--muted-foreground)" strokeDasharray="4 4" /><ChartTooltip content={<ChartTooltipContent formatter={(value) => <span className="font-medium tabular-nums">{formatUSD(Math.round(Number(value) * 100))}</span>} />} /><Area isAnimationActive={!still} dataKey="netWorth" name="Projected net worth" type="monotone" stroke="var(--color-netWorth)" fill="url(#future-fill)" strokeWidth={2.5} /></AreaChart></ChartContainer></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Milestone path</CardTitle><CardDescription>Dates move immediately with your assumptions.</CardDescription></CardHeader><CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{milestones.map(({ value, date }) => <div key={value} className="flex items-center gap-3 rounded-xl border bg-muted/20 p-3"><span className="grid size-9 place-items-center rounded-full bg-primary/10 text-primary"><Target className="size-4" /></span><div><div className="font-medium tabular-nums">{formatUSD(value * 100)}</div><div className="text-xs text-muted-foreground">{formatDate(date)}</div></div></div>)}</CardContent></Card>
      </div>
    </div>
    <Card className="border-warning/25 bg-warning/5"><CardContent className="flex gap-3 pt-5 text-sm leading-6 text-muted-foreground"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-warning" /><p><strong className="text-foreground">Planning estimate only.</strong> This page does not predict investment returns, taxes, compensation, or expenses. Annual wealth creation is an assumption you control; personal spending is shown to keep the plan grounded, not subtracted again from that assumption.</p></CardContent></Card>
  </div>;
}
