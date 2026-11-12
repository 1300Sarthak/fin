"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Disclosure, Field, MoneyInput, Section, Stat, StatGroup, StickyActions, ToggleChip, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import type { PlanningProfile, TaxProfile } from "@/lib/financial-planning-core";
import { calculateTaxPlan, TAX_SOURCES, TAX_VERIFIED_AS_OF } from "@/lib/tax-planning";

const dollars = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
const RESEARCH_PROMPT = "Review my saved financial plan and tax opportunities. Explain tradeoffs, check my assumptions, and prioritize practical next steps.";
const KIND_TONE: Record<string, string> = {
  record: "bg-muted text-muted-foreground",
  deduction: "bg-positive/10 text-positive",
  credit: "bg-info/10 text-info",
  eligibility: "bg-warning/10 text-warning",
};

type MoneyKey = "wagesBox1" | "withholdingBox2" | "otherOrdinaryIncome" | "retirementContributions" | "confirmedAdjustments" | "confirmedItemizedDeductions" | "eligibleCashDonations";
const INCOME_FIELDS: { key: MoneyKey; label: string; help: string }[] = [
  { key: "wagesBox1", label: "W-2 wages (Box 1)", help: "All W-2s, including your spouse's if filing jointly. Box 1 is already net of pretax payroll deferrals." },
  { key: "withholdingBox2", label: "Federal withholding (Box 2)", help: "Recorded for planning. A refund is not calculated." },
  { key: "otherOrdinaryIncome", label: "Other ordinary income", help: "For example taxable interest. Exclude capital gains and qualified dividends." },
  { key: "retirementContributions", label: "Your workplace retirement deferrals", help: "Traditional + Roth employee deferrals, one person. Tracks remaining room without subtracting from Box 1." },
];
const DEDUCTION_FIELDS: { key: MoneyKey; label: string; help: string }[] = [
  { key: "confirmedAdjustments", label: "Confirmed income adjustments", help: "Eligible Schedule 1 adjustments only, after limits. Never repeat payroll deductions." },
  { key: "confirmedItemizedDeductions", label: "Confirmed itemized deductions", help: "Eligible Schedule A total after SALT, mortgage, medical, charitable, and other limits." },
  { key: "eligibleCashDonations", label: "Cash donations (non-itemizer)", help: "Qualified organizations only. Used with the standard deduction, never added to itemized deductions." },
];

/** Taxes view of the shared planning profile. Saves through /api/planning like the planning page. */
export function TaxWorkspace({ initialProfile }: { initialProfile: PlanningProfile }) {
  const [profile, setProfile] = useState(initialProfile);
  const [saved, setSaved] = useState(initialProfile);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const tax = calculateTaxPlan(profile.tax);
  const t = profile.tax;

  function update<K extends keyof PlanningProfile>(key: K, value: PlanningProfile[K]) { setProfile((current) => ({ ...current, [key]: value })); setDirty(true); }
  function updateTax<K extends keyof TaxProfile>(key: K, value: TaxProfile[K]) { setProfile((current) => ({ ...current, tax: { ...current.tax, [key]: value } })); setDirty(true); }
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save your plan.");
      setSaved(profile);
      setDirty(false);
      toast.success("Plan saved", { description: "The site and the CLI now read these inputs." });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your plan.");
    } finally {
      setSaving(false);
    }
  }
  function discard() { setProfile(saved); setDirty(false); }

  const hasDeductions = DEDUCTION_FIELDS.some((f) => t[f.key] > 0);
  const chips: { key: "hasSelfEmployment" | "hasDependents" | "hasEducationExpenses" | "hasHsa" | "specialStandardDeduction" | "spouseItemizes"; label: string }[] = [
    { key: "hasSelfEmployment", label: "Self-employment or business income" },
    { key: "hasDependents", label: "Dependents or dependent care" },
    { key: "hasEducationExpenses", label: "Education expenses" },
    { key: "hasHsa", label: "Health savings account (HSA)" },
    { key: "specialStandardDeduction", label: "65+, blind, or claimed as a dependent" },
    ...(t.filingStatus === "separate" ? [{ key: "spouseItemizes" as const, label: "My spouse itemizes" }] : []),
  ];

  return (
    <form onSubmit={save}>
      <fieldset disabled={saving} className="min-w-0 space-y-10">
        <StatGroup cols={4}>
          <Stat label="Federal income tax" value={tax.ordinaryIncomeTaxBeforeCredits === null ? "Needs review" : dollars(tax.ordinaryIncomeTaxBeforeCredits)} tone={tax.ordinaryIncomeTaxBeforeCredits === null ? "warning" : "none"} sub="Ordinary income, before credits" help="An illustration before credits. Excludes state, payroll, self-employment, capital-gains, and other taxes." />
          <Stat label="Deduction used" value={dollars(tax.deduction)} sub={tax.deductionMethod === "itemized" ? "Your confirmed itemized amount" : "Standard + eligible cash gifts"} />
          <Stat label="Taxable income" value={dollars(tax.taxableIncome)} sub="Ordinary, after deductions" help="Entered income minus confirmed adjustments and deductions." />
          <Stat label="401(k) room left" value={dollars(tax.baseRetirementRoom)} tone="positive" sub="Of the $24,500 base limit" help="Per person. Excludes catch-up contributions and does not check plan eligibility." />
        </StatGroup>

        <Section
          title="2026 tax profile"
          description="Annual household figures: expected full-year totals, or final forms when you have them. No SSN, address, or employer identity needed."
          surface
          bodyClassName="p-5 md:p-6"
        >
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            <Field label="Filing status" htmlFor="tax-filing">
              <select id="tax-filing" className={inputClass} value={t.filingStatus} onChange={(event) => updateTax("filingStatus", event.target.value as TaxProfile["filingStatus"])}>
                <option value="single">Single</option>
                <option value="joint">Married filing jointly</option>
                <option value="head">Head of household</option>
                <option value="separate">Married filing separately</option>
              </select>
            </Field>
            {INCOME_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`tax-${f.key}`} help={f.help}>
                <MoneyInput id={`tax-${f.key}`} value={t[f.key]} onChange={(value) => updateTax(f.key, value)} />
              </Field>
            ))}
          </div>
          <Disclosure className="mt-6 border-t pt-4" summary="Adjustments and deductions" hint="Only amounts you have confirmed" defaultOpen={hasDeductions}>
            <div className="grid gap-x-6 gap-y-5 pt-2 sm:grid-cols-2">
              {DEDUCTION_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`tax-${f.key}`} help={f.help}>
                  <MoneyInput id={`tax-${f.key}`} value={t[f.key]} onChange={(value) => updateTax(f.key, value)} />
                </Field>
              ))}
            </div>
          </Disclosure>
        </Section>

        <Section title="What applies to you" description="Pick any that fit. Matching opportunities appear below.">
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <ToggleChip key={chip.key} pressed={t[chip.key]} onPressedChange={(value) => updateTax(chip.key, value)}>{chip.label}</ToggleChip>
            ))}
          </div>
        </Section>

        {tax.unsupportedReasons.length > 0 && (
          <div role="note" className="drop-in border-warning/40 bg-warning/5 flex gap-3 rounded-xl border p-4">
            <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">This profile needs a full tax calculation</p>
              {tax.unsupportedReasons.map((reason) => <p key={reason} className="text-muted-foreground">{reason}</p>)}
            </div>
          </div>
        )}

        <Section title="Worth a closer look" description={`${tax.opportunities.length} items based on your profile. Deductions lower taxable income; credits lower tax.`} surface>
          <ul className="stagger divide-y">
            {tax.opportunities.map((item) => (
              <li key={item.title} className="grid gap-x-6 gap-y-1.5 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:px-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{item.title}</h3>
                    <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-medium first-letter:uppercase", KIND_TONE[item.kind.split(" ")[0]] ?? KIND_TONE.record)}>{item.kind}</span>
                  </div>
                  <p className="text-muted-foreground mt-1 max-w-[75ch] text-[13px] leading-relaxed">{item.detail}</p>
                </div>
                <a href={item.source} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1 self-start text-[13px] underline-offset-4 hover:underline">
                  IRS guidance<ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Notes and sharing" surface bodyClassName="space-y-4 p-5 md:p-6">
          <Field label="Context for your plan" htmlFor="tax-notes" hint={`${profile.notes.length}/4000`}>
            <textarea id="tax-notes" className={cn(inputClass, "h-auto min-h-24 py-2.5 leading-relaxed")} maxLength={4000} placeholder="Priorities, upcoming changes, and questions to explore…" value={profile.notes} onChange={(event) => update("notes", event.target.value)} />
          </Field>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" className="accent-brand mt-0.5 size-4" checked={profile.shareWithAgent} onChange={(event) => update("shareWithAgent", event.target.checked)} />
            <span className="text-sm">
              Let the research assistant use my saved planning and tax inputs
              <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">Sent to your configured AI provider only during a research request. Spreadsheet sharing is set separately in Settings. Saving never calls an AI.</span>
            </span>
          </label>
          <Link href={`/assistant?mode=research&prompt=${encodeURIComponent(RESEARCH_PROMPT)}`} className="text-brand inline-flex h-8 items-center gap-1 text-[13px] font-medium underline-offset-4 hover:underline">
            Explore with the assistant<ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </Section>

        <Disclosure summary="Limitations and sources" hint={`Rules checked ${TAX_VERIFIED_AS_OF}`}>
          <div className="text-muted-foreground max-w-[80ch] space-y-3 text-[13px] leading-relaxed">
            <p>{tax.limitations}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
              {TAX_SOURCES.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer" className="hover:text-foreground underline underline-offset-4">{source.title}</a></li>)}
            </ul>
          </div>
        </Disclosure>
      </fieldset>

      <StickyActions show={dirty || saving} message="Unsaved changes. Estimates update as you type.">
        <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={saving}>Discard</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save plan"}</Button>
      </StickyActions>
    </form>
  );
}
