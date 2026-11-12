"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Disclosure, Field, MoneyInput, Section, Stat, StatGroup, StickyActions, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/format";
import { calculateFinancialPlan, type PlanningProfile } from "@/lib/financial-planning-core";

const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
const RESEARCH_PROMPT = "Review my saved financial plan and tax opportunities. Explain tradeoffs, check my assumptions, and prioritize practical next steps.";

type MoneyKey = "monthlyTakeHome" | "monthlyEssentials" | "monthlyFlexible" | "monthlyDebtPayments" | "monthlyInvesting";
const MONTHLY_FIELDS: { key: MoneyKey; label: string; help?: string }[] = [
  { key: "monthlyTakeHome", label: "Take-home pay", help: "After taxes and payroll deductions." },
  { key: "monthlyEssentials", label: "Essentials", help: "Housing, groceries, utilities, insurance." },
  { key: "monthlyFlexible", label: "Flexible spending" },
  { key: "monthlyDebtPayments", label: "Debt payments", help: "Avoid counting card purchases and their payoff twice." },
  { key: "monthlyInvesting", label: "Investing from take-home", help: "Exclude contributions already deducted from pay." },
];

/** The monthly plan: every dollar a job, a reserve target, and one goal. Saves through /api/planning, shared with Taxes and the CLI (`fin plan`). */
export function PlanningWorkspace({ initialProfile, liquidAssetsCents, uploadCount }: { initialProfile: PlanningProfile; liquidAssetsCents: number; uploadCount: number }) {
  const [profile, setProfile] = useState(initialProfile);
  const [saved, setSaved] = useState(initialProfile);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const plan = calculateFinancialPlan(profile, liquidAssetsCents);

  function update<K extends keyof PlanningProfile>(key: K, value: PlanningProfile[K]) { setProfile((current) => ({ ...current, [key]: value })); setDirty(true); }
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save your plan.");
      setSaved(profile);
      setDirty(false);
      toast.success("Plan saved", { description: "Your plan is available in the site and CLI." });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your plan.");
    } finally {
      setSaving(false);
    }
  }
  function discard() { setProfile(saved); setDirty(false); }

  const reserveNote = plan.reserveGap > 0
    ? `Your reserve gap is ${dollars(plan.reserveGap)}.${plan.monthsToReserve !== null ? ` It would take about ${plan.monthsToReserve} months if all unallocated cash went there.` : " Create monthly room before setting a funding timeline."}`
    : "Your liquid assets cover the reserve target you entered. Other commitments may already be using that cash.";
  const goalNote = profile.goalTarget
    ? plan.goalAffordable
      ? `Your monthly plan has room for this goal. Allocate ${dollars(plan.goalMonthlyNeeded)} each month.`
      : `This goal needs ${dollars(Math.max(0, plan.goalMonthlyNeeded - plan.monthlyRemaining))} more monthly room. Adjust its timeline, target, or spending.`
    : "Name a goal and enter a target to see the monthly amount it needs.";

  return (
    <form onSubmit={save}>
      <fieldset disabled={saving} className="min-w-0 space-y-10">
        <StatGroup cols={4}>
          <Stat label="Unallocated / mo" value={dollars(plan.monthlyRemaining)} tone={plan.monthlyRemaining < 0 ? "negative" : plan.monthlyRemaining > 0 ? "positive" : "none"} sub={plan.monthlyRemaining < 0 ? "Over take-home pay" : "After costs and investing"} help={`Unallocated each month. ${plan.monthlyRemaining < 0 ? "Your planned spending exceeds take-home pay." : "After living costs, debt payments, and investing."}`} />
          <Stat label="Reserve target" value={dollars(plan.reserveTarget)} sub={`${profile.emergencyMonths} months of essentials`} help={`Emergency reserve target: ${profile.emergencyMonths} months of essentials and debt payments.`} />
          <Stat label="Liquid reserve" value={dollars(liquidAssetsCents / 100)} tone={plan.reserveGap > 0 ? "warning" : "none"} sub={plan.reserveGap > 0 ? `${dollars(plan.reserveGap)} short of target` : "Covers the target"} help={`Liquid reserve today: active cash, bank, and savings accounts before liabilities. ${reserveNote}`} />
          <Stat label="Goal need / mo" value={dollars(plan.goalMonthlyNeeded)} sub={profile.goalTarget ? `Per month, ${profile.goalMonths} months` : "Set a goal below"} help={`Goal contribution needed. ${profile.goalTarget ? `Per month over ${profile.goalMonths} months.` : "Set a goal to work backwards from its target."}`} />
        </StatGroup>

        <div className="grid gap-x-8 gap-y-10 xl:grid-cols-[1.25fr_1fr]">
          <Section title="Monthly plan" description="Expected take-home amounts. These assumptions never edit your ledger." surface bodyClassName="p-5 md:p-6">
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {MONTHLY_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`plan-${f.key}`} help={f.help}>
                  <MoneyInput id={`plan-${f.key}`} value={profile[f.key]} onChange={(value) => update(f.key, value)} />
                </Field>
              ))}
              <Field label="Emergency reserve" htmlFor="plan-emergency" hint="months">
                <input id="plan-emergency" className={cn(inputClass, "num")} type="number" min="1" max="24" value={profile.emergencyMonths} onChange={(event) => update("emergencyMonths", Math.max(1, Math.min(24, Math.trunc(Number(event.target.value)))))} />
              </Field>
            </div>
          </Section>

          <Section title="A goal with a clear next step" surface bodyClassName="space-y-5 p-5 md:p-6">
            <Field label="Goal name" htmlFor="plan-goal-name">
              <input id="plan-goal-name" className={inputClass} maxLength={120} placeholder="House deposit, travel, a fresh start…" value={profile.goalName} onChange={(event) => update("goalName", event.target.value)} />
            </Field>
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              <Field label="Target amount" htmlFor="plan-goal-target"><MoneyInput id="plan-goal-target" value={profile.goalTarget} onChange={(value) => update("goalTarget", value)} /></Field>
              <Field label="Already saved" htmlFor="plan-goal-saved" help="Already saved for this goal."><MoneyInput id="plan-goal-saved" value={profile.goalSaved} onChange={(value) => update("goalSaved", value)} /></Field>
            </div>
            <Field label="Months to target" htmlFor="plan-goal-months">
              <input id="plan-goal-months" className={cn(inputClass, "num")} type="number" min="1" max="600" value={profile.goalMonths} onChange={(event) => update("goalMonths", Math.max(1, Math.min(600, Math.trunc(Number(event.target.value)))))} />
            </Field>
            <p role="status" className={cn("rounded-lg px-3 py-2.5 text-[13px] leading-relaxed", !profile.goalTarget ? "bg-muted/60 text-muted-foreground" : plan.goalAffordable ? "bg-positive/10" : "bg-warning/10")}>{goalNote}</p>
          </Section>
        </div>

        <Section title="Notes and sharing" surface bodyClassName="space-y-4 p-5 md:p-6">
          <Field label="Context for your plan" htmlFor="plan-notes" hint={`${profile.notes.length}/4000`}>
            <textarea id="plan-notes" className={cn(inputClass, "h-auto min-h-24 py-2.5 leading-relaxed")} maxLength={4000} placeholder="Priorities, upcoming changes, and questions to explore…" value={profile.notes} onChange={(event) => update("notes", event.target.value)} />
          </Field>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" className="accent-brand mt-0.5 size-4" checked={profile.shareWithAgent} onChange={(event) => update("shareWithAgent", event.target.checked)} />
            <span className="text-sm">
              Let the research assistant use my saved planning and tax inputs
              <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">When enabled, relevant inputs can be sent to your configured AI provider during a research request. Spreadsheet sharing is controlled separately in Settings. Saving this form does not call an AI.</span>
            </span>
          </label>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <Link href={`/assistant?mode=research&prompt=${encodeURIComponent(RESEARCH_PROMPT)}`} className="text-brand inline-flex min-h-9 items-center gap-1 text-[13px] font-medium underline-offset-4 hover:underline">
              Explore with the assistant<ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
            <Link href="/settings#spreadsheets" className="text-muted-foreground hover:text-foreground inline-flex min-h-9 items-center gap-1 text-[13px] underline-offset-4 hover:underline">
              Spreadsheet knowledge · {pluralize(uploadCount, "saved file")}<ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
        </Section>

        <Disclosure summary="What the plan assumes">
          <ul className="text-muted-foreground max-w-[80ch] space-y-1.5 text-[13px] leading-relaxed">
            {plan.assumptions.map((item) => <li key={item} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{item}</li>)}
            <li className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{reserveNote}</li>
          </ul>
        </Disclosure>
      </fieldset>

      <StickyActions show={dirty || saving} message="Unsaved changes. Estimates update as you type.">
        <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={saving}>Discard</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save plan"}</Button>
      </StickyActions>
    </form>
  );
}
