"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check, Landmark, Save, ShieldCheck, Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/lib/format";
import { calculateFinancialPlan, type PlanningProfile, type TaxProfile } from "@/lib/financial-planning-core";
import { calculateTaxPlan, TAX_SOURCES, TAX_VERIFIED_AS_OF } from "@/lib/tax-planning";

const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
const fieldClass = "mt-1.5 h-11 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring";
function MoneyField({ label, value, onChange, hint }: { label: string; value: number; onChange: (value: number) => void; hint?: string }) {
  return <label className="block text-sm font-medium">{label}<input className={fieldClass} type="number" inputMode="decimal" min="0" max="100000000" step="0.01" value={value || ""} placeholder="0" onChange={event => { const next = Number(event.target.value); onChange(Number.isFinite(next) ? Math.min(100_000_000, Math.max(0, next)) : 0); }} />{hint ? <span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">{hint}</span> : null}</label>;
}
function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <StatCard label={label} value={value} sub={note} />;
}
function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>;
}

export function PlanningWorkspace({ initialProfile, liquidAssetsCents, uploadCount, mode = "planning" }: { initialProfile: PlanningProfile; liquidAssetsCents: number; uploadCount: number; mode?: "planning" | "tax" }) {
  const [profile, setProfile] = useState(initialProfile);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [dirty, setDirty] = useState(false);
  const [failed, setFailed] = useState(false);
  const plan = calculateFinancialPlan(profile, liquidAssetsCents);
  const tax = calculateTaxPlan(profile.tax);
  function update<K extends keyof PlanningProfile>(key: K, value: PlanningProfile[K]) { setProfile(current => ({ ...current, [key]: value })); setDirty(true); setStatus(""); }
  function updateTax<K extends keyof TaxProfile>(key: K, value: TaxProfile[K]) { setProfile(current => ({ ...current, tax: { ...current.tax, [key]: value } })); setDirty(true); setStatus(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setFailed(false);
    try {
      const response = await fetch("/api/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save your plan.");
      setDirty(false); setStatus("Saved. Your plan is available in the site and CLI.");
    } catch (error) { setFailed(true); setStatus(error instanceof Error ? error.message : "Could not save your plan."); }
    finally { setSaving(false); }
  }
  return <form onSubmit={save}><fieldset disabled={saving} className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3"><ShieldCheck className="size-5 text-primary" /><div><p className="text-sm font-medium">Your plan, connected</p><p className="text-xs text-muted-foreground">{dirty ? "Unsaved changes · estimates update as you type" : "Local inputs · shared by the site and CLI"}</p></div></div>
      <Button type="submit" disabled={saving || !dirty} className="min-h-11 px-4"><Save className="size-4" />{saving ? "Saving…" : "Save plan"}</Button>
    </div>
    {status ? <p role={failed ? "alert" : "status"} className={`text-sm ${failed ? "text-destructive" : "text-primary"}`}>{status}</p> : null}
    {mode === "planning" ? <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Unallocated each month" value={dollars(plan.monthlyRemaining)} note={plan.monthlyRemaining < 0 ? "Your planned spending exceeds take-home pay." : "After living costs, debt payments, and investing."} />
        <Metric label="Emergency reserve target" value={dollars(plan.reserveTarget)} note={`${profile.emergencyMonths} months of essentials and debt payments.`} />
        <Metric label="Liquid reserve today" value={dollars(liquidAssetsCents / 100)} note="Active cash, bank, and savings accounts before liabilities." />
        <Metric label="Goal contribution needed" value={dollars(plan.goalMonthlyNeeded)} note={profile.goalTarget ? `Per month over ${profile.goalMonths} months.` : "Set a goal to work backwards from its target."} />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Landmark className="size-4" />Monthly plan</CardTitle><p className="text-sm text-muted-foreground">Enter expected take-home amounts. These assumptions never edit your ledger.</p></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
          <MoneyField label="Take-home pay" value={profile.monthlyTakeHome} onChange={value => update("monthlyTakeHome", value)} hint="After taxes and payroll deductions." />
          <MoneyField label="Essentials" value={profile.monthlyEssentials} onChange={value => update("monthlyEssentials", value)} hint="Housing, groceries, utilities, insurance." />
          <MoneyField label="Flexible spending" value={profile.monthlyFlexible} onChange={value => update("monthlyFlexible", value)} />
          <MoneyField label="Debt payments" value={profile.monthlyDebtPayments} onChange={value => update("monthlyDebtPayments", value)} hint="Avoid counting card purchases and their payoff twice." />
          <MoneyField label="Investing from take-home" value={profile.monthlyInvesting} onChange={value => update("monthlyInvesting", value)} hint="Exclude contributions already deducted from pay." />
          <label className="text-sm font-medium">Emergency reserve months<input className={fieldClass} type="number" min="1" max="24" value={profile.emergencyMonths} onChange={event => update("emergencyMonths", Math.max(1, Math.min(24, Math.trunc(Number(event.target.value)))))} /></label>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Target className="size-4" />A goal with a clear next step</CardTitle></CardHeader><CardContent className="space-y-4">
          <label className="block text-sm font-medium">Goal name<input className={fieldClass} maxLength={120} placeholder="House deposit, travel, a fresh start…" value={profile.goalName} onChange={event => update("goalName", event.target.value)} /></label>
          <div className="grid gap-4 sm:grid-cols-2"><MoneyField label="Target amount" value={profile.goalTarget} onChange={value => update("goalTarget", value)} /><MoneyField label="Already saved for this goal" value={profile.goalSaved} onChange={value => update("goalSaved", value)} /></div>
          <label className="block text-sm font-medium">Months to target<input className={fieldClass} type="number" min="1" max="600" value={profile.goalMonths} onChange={event => update("goalMonths", Math.max(1, Math.min(600, Math.trunc(Number(event.target.value)))))} /></label>
          <div className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed">{profile.goalTarget ? plan.goalAffordable ? `Your monthly plan has room for this goal. Allocate ${dollars(plan.goalMonthlyNeeded)} each month.` : `This goal needs ${dollars(Math.max(0, plan.goalMonthlyNeeded - plan.monthlyRemaining))} more monthly room. Adjust its timeline, target, or spending.` : "Name a goal and enter a target to see the monthly amount it needs."}</div>
        </CardContent></Card>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Link href="/taxes" className="rounded-xl border bg-card p-5 transition-colors hover:bg-muted/50"><p className="flex items-center justify-between font-medium">Tax opportunities<ArrowUpRight className="size-4" /></p><p className="mt-2 text-sm text-muted-foreground">W-2 inputs, deductions, credits to investigate, and a 2026 federal tax illustration.</p></Link>
        <Link href="/settings#spreadsheets" className="rounded-xl border bg-card p-5 transition-colors hover:bg-muted/50"><p className="flex items-center justify-between font-medium">Spreadsheet knowledge<ArrowUpRight className="size-4" /></p><p className="mt-2 text-sm text-muted-foreground">{pluralize(uploadCount, "saved file")}. Add a budget, benefits worksheet, or other financial spreadsheet.</p></Link>
        <Link href="/future-plan" className="rounded-xl border bg-card p-5 transition-colors hover:bg-muted/50"><p className="flex items-center justify-between font-medium">Long-term scenarios<ArrowUpRight className="size-4" /></p><p className="mt-2 text-sm text-muted-foreground">Explore how contributions, time, and return assumptions affect future milestones.</p></Link>
      </div>
      <Card><CardContent className="space-y-3 p-5"><p className="font-medium">What the plan assumes</p>{plan.assumptions.map(item => <p key={item} className="flex gap-2 text-sm text-muted-foreground"><Check className="mt-0.5 size-4 shrink-0" />{item}</p>)}<p className="text-sm text-muted-foreground">{plan.reserveGap > 0 ? `Your reserve gap is ${dollars(plan.reserveGap)}.${plan.monthsToReserve !== null ? ` It would take about ${plan.monthsToReserve} months if all unallocated cash went there.` : " Create monthly room before setting a funding timeline."}` : "Your liquid assets cover the reserve target you entered. Other commitments may already be using that cash."}</p></CardContent></Card>
    </> : <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Federal ordinary income tax" value={tax.ordinaryIncomeTaxBeforeCredits === null ? "Needs review" : dollars(tax.ordinaryIncomeTaxBeforeCredits)} note="Illustration before credits; excludes other taxes." />
        <Metric label="Deduction used" value={dollars(tax.deduction)} note={`${tax.deductionMethod === "itemized" ? "Your confirmed itemized amount" : "Standard deduction + eligible cash gifts"}.`} />
        <Metric label="Taxable ordinary income" value={dollars(tax.taxableIncome)} note="Entered income minus confirmed adjustments and deductions." />
        <Metric label="Base 401(k) room" value={dollars(tax.baseRetirementRoom)} note="Per person, $24,500 limit. Excludes catch-ups; no eligibility check." />
      </div>
      <Card><CardHeader><CardTitle>2026 tax profile</CardTitle><p className="text-sm text-muted-foreground">Annual household figures in USD. Use expected full-year totals, or final forms when available. No SSN, address, or employer identity needed.</p></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm font-medium">Filing status<select className={fieldClass} value={profile.tax.filingStatus} onChange={event => updateTax("filingStatus", event.target.value as TaxProfile["filingStatus"])}><option value="single">Single</option><option value="joint">Married filing jointly</option><option value="head">Head of household</option><option value="separate">Married filing separately</option></select></label>
        <MoneyField label="W-2 Box 1 wages" value={profile.tax.wagesBox1} onChange={value => updateTax("wagesBox1", value)} hint="All W-2s, including spouse if filing jointly. Already net of pretax payroll deferrals." />
        <MoneyField label="W-2 Box 2 federal withholding" value={profile.tax.withholdingBox2} onChange={value => updateTax("withholdingBox2", value)} hint="Recorded for planning. We do not calculate a refund." />
        <MoneyField label="Other ordinary income" value={profile.tax.otherOrdinaryIncome} onChange={value => updateTax("otherOrdinaryIncome", value)} hint="For example taxable interest. Exclude capital gains and qualified dividends." />
        <MoneyField label="Confirmed income adjustments" value={profile.tax.confirmedAdjustments} onChange={value => updateTax("confirmedAdjustments", value)} hint="Eligible Schedule 1 adjustments only, after limits. Never repeat payroll deductions." />
        <MoneyField label="Confirmed itemized deduction total" value={profile.tax.confirmedItemizedDeductions} onChange={value => updateTax("confirmedItemizedDeductions", value)} hint="Eligible Schedule A amount after SALT, mortgage, medical, charitable, and other limits." />
        <MoneyField label="Eligible non-itemizer cash donations" value={profile.tax.eligibleCashDonations} onChange={value => updateTax("eligibleCashDonations", value)} hint="Qualified organizations only. Used with the standard deduction, never added to itemized deductions." />
        <MoneyField label="Your workplace retirement deferrals" value={profile.tax.retirementContributions} onChange={value => updateTax("retirementContributions", value)} hint="Traditional + Roth employee deferrals, one person. Tracks room without subtracting from Box 1." />
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Find relevant opportunities</CardTitle></CardHeader><CardContent className="grid gap-x-6 sm:grid-cols-2">
        <CheckField label="I have self-employment or business income" checked={profile.tax.hasSelfEmployment} onChange={value => updateTax("hasSelfEmployment", value)} />
        <CheckField label="I have dependents or dependent-care expenses" checked={profile.tax.hasDependents} onChange={value => updateTax("hasDependents", value)} />
        <CheckField label="I have education expenses" checked={profile.tax.hasEducationExpenses} onChange={value => updateTax("hasEducationExpenses", value)} />
        <CheckField label="I have a health savings account (HSA)" checked={profile.tax.hasHsa} onChange={value => updateTax("hasHsa", value)} />
        <CheckField label="Age 65+, blindness, or someone can claim me as a dependent" checked={profile.tax.specialStandardDeduction} onChange={value => updateTax("specialStandardDeduction", value)} />
        {profile.tax.filingStatus === "separate" ? <CheckField label="My spouse itemizes deductions" checked={profile.tax.spouseItemizes} onChange={value => updateTax("spouseItemizes", value)} /> : null}
      </CardContent></Card>
      {tax.unsupportedReasons.length ? <div className="rounded-xl border border-warning/40 bg-warning/5 p-5"><p className="font-medium">This profile needs a full tax calculation</p>{tax.unsupportedReasons.map(reason => <p key={reason} className="mt-2 text-sm text-muted-foreground">{reason}</p>)}</div> : null}
      <div className="grid gap-4 md:grid-cols-2">{tax.opportunities.map(item => <Card key={item.title}><CardContent className="p-5"><p className="text-xs uppercase tracking-wider text-muted-foreground">{item.kind}</p><h2 className="mt-2 font-semibold">{item.title}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.detail}</p><a href={item.source} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm text-primary underline underline-offset-4">IRS guidance<ArrowUpRight className="size-3" /></a></CardContent></Card>)}</div>
      <Card><CardContent className="p-5"><p className="text-sm leading-relaxed text-muted-foreground">{tax.limitations}</p><p className="mt-4 text-xs font-medium">Rules checked {TAX_VERIFIED_AS_OF}. Deductions lower taxable income; credits lower tax.</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{TAX_SOURCES.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline underline-offset-4">{source.title}</a>)}</div></CardContent></Card>
    </>}
    <Card><CardContent className="space-y-3 p-5"><label className="block text-sm font-medium">Context for your plan<textarea className="mt-2 min-h-24 w-full rounded-lg border bg-background p-3 text-sm focus-visible:outline-ring" maxLength={4000} placeholder="Priorities, upcoming changes, and questions to explore…" value={profile.notes} onChange={event => update("notes", event.target.value)} /></label><CheckField label="Allow the research assistant to use my saved planning and tax inputs" checked={profile.shareWithAgent} onChange={value => update("shareWithAgent", value)} /><p className="text-xs leading-relaxed text-muted-foreground">When enabled, relevant inputs can be sent to your configured AI provider during a research request. Spreadsheet sharing is controlled separately in Settings. Saving this form does not call an AI.</p><div className="flex flex-wrap items-center gap-4"><Button type="submit" disabled={saving || !dirty} className="min-h-11 px-4">{saving ? "Saving…" : "Save plan"}</Button><Link href={`/research?prompt=${encodeURIComponent("Review my saved financial plan and tax opportunities. Explain tradeoffs, check my assumptions, and prioritize practical next steps.")}`} className="inline-flex min-h-11 items-center gap-1 text-sm text-primary underline underline-offset-4">Explore with the assistant<ArrowUpRight className="size-4" /></Link></div></CardContent></Card>
  </fieldset></form>;
}
