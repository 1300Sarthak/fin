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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import type { GoalType } from "@/db/schema";
import type { GoalNode } from "@/lib/planner";

const GOAL_TYPES: { value: GoalType; label: string }[] = [
  { value: "custom", label: "Custom" },
  { value: "emergency_fund", label: "Emergency fund" },
  { value: "retirement", label: "Retirement" },
  { value: "taxable_invest", label: "Taxable investing" },
  { value: "debt_payoff", label: "Debt payoff" },
];

const selectClass =
  "border-input bg-transparent dark:bg-input/30 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none";

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
  const [selected, setSelected] = React.useState<Set<number>>(new Set(goal?.accountIds ?? []));
  const [busy, setBusy] = React.useState(false);

  // A parent goal's totals roll up from children; account links don't apply.
  const accountLinkDisabled = hasChildren;

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
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        type,
        targetCents: Math.round(Number(target || 0) * 100),
        priority: Number(priority || 0),
        parentGoalId: parentId ? Number(parentId) : null,
        accountIds: accountLinkDisabled ? [] : [...selected],
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
            <Button variant="outline" size="sm">
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

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="goal-name">Name</Label>
            <Input id="goal-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Japan trip" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="goal-type">Type</Label>
              <select id="goal-type" value={type} onChange={(e) => setType(e.target.value as GoalType)} className={selectClass}>
                {GOAL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-priority">Priority</Label>
              <Input
                id="goal-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="goal-target">Target ($)</Label>
            <Input
              id="goal-target"
              type="number"
              min="0"
              step="100"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="5000"
              disabled={hasChildren}
            />
            {hasChildren && (
              <p className="text-muted-foreground text-xs">Target rolls up from sub-goals.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="goal-parent">Sub-goal of</Label>
            <select id="goal-parent" value={parentId} onChange={(e) => setParentId(e.target.value)} className={selectClass}>
              <option value="">None (top-level)</option>
              {parentOptions
                .filter((p) => p.id !== goal?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>

          {!accountLinkDisabled && accounts.length > 0 && (
            <div className="space-y-1.5">
              <Label>Linked accounts</Label>
              <p className="text-muted-foreground text-xs">
                Progress tracks the summed balance of any accounts you check.
              </p>
              <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-2">
                {accounts.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.has(a.id)}
                      onCheckedChange={(c) => toggleAccount(a.id, c)}
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            </div>
          )}
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
