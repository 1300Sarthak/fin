"use client";

import * as React from "react";
import { Plus, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Disclosure, Field, HelpTip, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import type { GoalType } from "@/db/schema";
import type { GoalNode } from "@/lib/planner";
import { PROGRESS_KINDS, PROGRESS_KIND_LABEL, type ProgressKind } from "@/lib/goals-core";

const MEASURE_HELP = "Account balance tracks linked accounts. The others count money put in for one tax year from the ledger (Roth IRA and HSA contributions, 401(k) deferrals), or an amount you enter, such as student loan interest from Form 1098-E.";

const GOAL_TYPES: { value: GoalType; label: string }[] = [
  { value: "custom", label: "Custom" },
  { value: "emergency_fund", label: "Emergency fund" },
  { value: "retirement", label: "Retirement" },
  { value: "taxable_invest", label: "Taxable investing" },
  { value: "debt_payoff", label: "Debt payoff" },
];

export function GoalDialog({
  accounts,
  parentOptions,
  goal,
}: {
  accounts: { id: number; name: string }[];
  parentOptions: { id: number; name: string }[];
  goal?: GoalNode;
}) {
  const router = useRouter();
  const editing = !!goal;
  const hasChildren = (goal?.children?.length ?? 0) > 0;

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(goal?.name ?? "");
  const [type, setType] = React.useState<GoalType>(goal?.type ?? "custom");
  const [target, setTarget] = React.useState(goal ? String(goal.targetCents / 100) : "");
  const [priority, setPriority] = React.useState(String(goal?.priority ?? 0));
  const [parentId, setParentId] = React.useState(goal?.parentGoalId ? String(goal.parentGoalId) : "");
  const [kind, setKind] = React.useState<ProgressKind>(goal?.progressKind ?? "balance");
  const [taxYear, setTaxYear] = React.useState(goal?.taxYear != null ? String(goal.taxYear) : String(new Date().getFullYear()));
  const [manual, setManual] = React.useState(goal?.manualProgressCents != null ? String(goal.manualProgressCents / 100) : "");
  const [selected, setSelected] = React.useState<Set<number>>(new Set(goal?.accountIds ?? []));
  const [busy, setBusy] = React.useState(false);

  // A parent goal's totals roll up from children; account links don't apply.
  const accountLinkDisabled = hasChildren || kind !== "balance";

  function toggleAccount(id: number, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) return toast.error("Enter a name");
    const year = Number(taxYear);
    if (kind !== "balance" && (!Number.isInteger(year) || year < 2000 || year > 2100)) return toast.error("Enter a tax year like 2026");
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        type,
        targetCents: Math.round(Number(target || 0) * 100),
        priority: Number(priority || 0),
        parentGoalId: parentId ? Number(parentId) : null,
        accountIds: accountLinkDisabled ? [] : [...selected],
        progressKind: kind,
        taxYear: kind === "balance" ? null : year,
        manualProgressCents: kind === "manual" && manual !== "" ? Math.round(Number(manual) * 100) : null,
      };
      const res = await fetch("/api/goals", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: goal!.id, ...payload } : payload),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success(editing ? "Goal updated" : "Goal created");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          editing ? (
            <Button variant="ghost" size="icon-sm" aria-label="Edit goal">
              <Pencil className="size-4" />
            </Button>
          ) : (
            <Button size="sm" className="h-9">
              <Plus className="size-4" />
              Add goal
            </Button>
          )
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit goal" : "New goal"}</DialogTitle>
          <DialogDescription>
            Track a target, link real accounts, or split it into sub-goals.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Name" htmlFor="goal-name">
            <input id="goal-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Japan trip" />
          </Field>

          <Field label="Target" htmlFor="goal-target" hint={hasChildren ? "Rolls up from sub-goals" : undefined}>
            <div className="relative">
              <span aria-hidden="true" className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm">$</span>
              <input id="goal-target" className={cn(inputClass, "num pl-6")} type="number" inputMode="decimal" min="0" step="100" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="5000" disabled={hasChildren} />
            </div>
          </Field>

          {!hasChildren && (
            <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
              <Field label="Measure by" htmlFor="goal-kind" help={MEASURE_HELP} className="sm:col-span-2">
                <select id="goal-kind" value={kind} onChange={(e) => setKind(e.target.value as ProgressKind)} className={inputClass}>
                  {PROGRESS_KINDS.map((k) => <option key={k} value={k}>{PROGRESS_KIND_LABEL[k]}</option>)}
                </select>
              </Field>
              {kind !== "balance" && (
                <Field label="Tax year" htmlFor="goal-year" help="Only money for this year counts. IRA and HSA contributions for a year can be made until the next April 15.">
                  <input id="goal-year" className={cn(inputClass, "num")} type="number" inputMode="numeric" min="2000" max="2100" step="1" value={taxYear} onChange={(e) => setTaxYear(e.target.value)} />
                </Field>
              )}
              {kind === "manual" && (
                <Field label="Amount so far" htmlFor="goal-manual" help="For student loan interest, the interest paid this year from the servicer or Form 1098-E. Principal does not count." className="sm:col-span-2">
                  <div className="relative">
                    <span aria-hidden="true" className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm">$</span>
                    <input id="goal-manual" className={cn(inputClass, "num pl-6")} type="number" inputMode="decimal" min="0" step="0.01" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="0.00" />
                  </div>
                </Field>
              )}
            </div>
          )}

          {!accountLinkDisabled && accounts.length > 0 && (
            <fieldset className="min-w-0">
              <legend className="mb-1.5 flex items-center gap-1 text-[13px] font-medium">Linked accounts<HelpTip label="About linked accounts">Progress tracks the summed balance of any accounts you check.</HelpTip></legend>
              <div className="max-h-44 divide-y overflow-y-auto rounded-lg border">
                {accounts.map((a) => (
                  <label key={a.id} className="hoverable flex min-h-11 cursor-pointer items-center gap-2.5 px-3 text-sm sm:min-h-9">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={(c) => toggleAccount(a.id, c)} />
                    {a.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <Disclosure summary="Type, priority and parent" hint={editing ? undefined : "Optional"} defaultOpen={editing && (type !== "custom" || priority !== "0" || !!parentId)}>
            <div className="grid gap-x-4 gap-y-5 pt-1 sm:grid-cols-2">
              <Field label="Type" htmlFor="goal-type">
                <select id="goal-type" value={type} onChange={(e) => setType(e.target.value as GoalType)} className={inputClass}>
                  {GOAL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Priority" htmlFor="goal-priority" help="The contribution plan funds the earliest deadline first; priority (lower first) breaks ties and orders goals with no deadline.">
                <input id="goal-priority" className={cn(inputClass, "num")} type="number" value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="0" />
              </Field>
              <Field label="Sub-goal of" htmlFor="goal-parent" className="sm:col-span-2">
                <select id="goal-parent" value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputClass}>
                  <option value="">None (top-level)</option>
                  {parentOptions.filter((p) => p.id !== goal?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            </div>
          </Disclosure>
        </div>

        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Create goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
