"use client";

import * as React from "react";
import { Plus, Pencil, X } from "lucide-react";
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
import { formatUSD } from "@/lib/format";
import type { HistoryMilestone } from "@/lib/milestones";

type LineDraft = {
  key: string;
  label: string;
  amount: string; // dollars, as typed — "-505.06" for debt
  note: string;
  excluded: boolean;
};

let seq = 0;
const newKey = () => `l${seq++}`;

const blankLine = (): LineDraft => ({
  key: newKey(),
  label: "",
  amount: "",
  note: "",
  excluded: false,
});

const toDraft = (
  l: { label: string; cents: number; note?: string | null },
  excluded: boolean,
): LineDraft => ({
  key: newKey(),
  label: l.label,
  amount: String(l.cents / 100),
  note: l.note ?? "",
  excluded,
});

/** Local calendar date — toISOString() is UTC and rolls over a day early west of it. */
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Add or edit a hand-recorded net worth checkpoint.
 *
 * A new checkpoint prefills its line labels from the previous one with the
 * amounts blank — the same accounts get listed every time, so the work is
 * typing six numbers, not rebuilding the list. The recorded total is optional
 * and falls back to the sum of the lines; entering one keeps whatever figure
 * was actually written down, even when it disagrees with the lines.
 */
export function MilestoneDialog({
  milestone,
  previous,
}: {
  milestone?: HistoryMilestone;
  previous?: HistoryMilestone;
}) {
  const router = useRouter();
  const editing = !!milestone;
  const template = milestone ?? previous;

  function initialLines(): LineDraft[] {
    if (milestone) {
      return [
        ...milestone.included.map((l) => toDraft(l, false)),
        ...milestone.excluded.map((l) => toDraft(l, true)),
      ];
    }
    if (previous) {
      // Same accounts, blank amounts.
      return [
        ...previous.included.map((l) => ({ ...toDraft(l, false), amount: "" })),
        ...previous.excluded.map((l) => ({ ...toDraft(l, true), amount: "" })),
      ];
    }
    return [blankLine()];
  }

  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(milestone?.date ?? today());
  const [lines, setLines] = React.useState<LineDraft[]>(initialLines);
  const [total, setTotal] = React.useState(
    milestone ? String(milestone.totalCents / 100) : "",
  );
  const [goal, setGoal] = React.useState(milestone?.goal ?? "");
  const [note, setNote] = React.useState(milestone?.note ?? "");
  const [busy, setBusy] = React.useState(false);

  /** Reopening starts from a clean draft, so a cancelled edit doesn't linger. */
  function onOpenChange(next: boolean) {
    if (next) {
      setDate(milestone?.date ?? today());
      setLines(initialLines());
      setTotal(milestone ? String(milestone.totalCents / 100) : "");
      setGoal(milestone?.goal ?? "");
      setNote(milestone?.note ?? "");
    }
    setOpen(next);
  }

  function patch(key: string, next: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...next } : l)));
  }

  const computedCents = lines
    .filter((l) => !l.excluded && l.label.trim() && l.amount.trim())
    .reduce((s, l) => s + Math.round(Number(l.amount) * 100 || 0), 0);

  async function save() {
    const filled = lines.filter((l) => l.label.trim() && l.amount.trim());
    if (!date) return toast.error("Pick a date");
    if (!filled.some((l) => !l.excluded)) {
      return toast.error("Add at least one account line");
    }
    if (filled.some((l) => !Number.isFinite(Number(l.amount)))) {
      return toast.error("Every amount must be a number");
    }

    setBusy(true);
    try {
      const pack = (excluded: boolean) =>
        filled
          .filter((l) => l.excluded === excluded)
          .map((l) => ({
            label: l.label.trim(),
            cents: Math.round(Number(l.amount) * 100),
            note: l.note.trim() || null,
          }));

      const res = await fetch("/api/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          totalCents: total.trim() ? Math.round(Number(total) * 100) : undefined,
          goal: goal.trim() || null,
          note: note.trim() || null,
          included: pack(false),
          excluded: pack(true),
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success(editing ? "Checkpoint updated" : "Checkpoint added");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          editing ? (
            <Button variant="ghost" size="icon-sm" aria-label="Edit checkpoint">
              <Pencil className="size-4" />
            </Button>
          ) : (
            <Button variant="outline" size="sm">
              <Plus className="size-4" />
              Add checkpoint
            </Button>
          )
        }
      />

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit checkpoint" : "Add net worth checkpoint"}
          </DialogTitle>
          <DialogDescription>
            {template && !editing
              ? "Lines are carried over from your last checkpoint — just fill in the new amounts."
              : "Record what each account held on this date. Use a negative amount for debt."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="milestone-date">Date</Label>
            <Input
              id="milestone-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Accounts</Label>
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2">
                <Input
                  placeholder="Savings"
                  value={l.label}
                  onChange={(e) => patch(l.key, { label: e.target.value })}
                  className="flex-1"
                />
                <Input
                  placeholder="0.00"
                  inputMode="decimal"
                  value={l.amount}
                  onChange={(e) => patch(l.key, { amount: e.target.value })}
                  className="w-28 text-right tabular-nums"
                />
                <label
                  className="text-muted-foreground flex items-center gap-1 text-xs"
                  title="Track alongside, but leave out of the total"
                >
                  <Checkbox
                    checked={l.excluded}
                    onCheckedChange={(v) => patch(l.key, { excluded: v === true })}
                  />
                  <span className="hidden sm:inline">Exclude</span>
                </label>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${l.label || "line"}`}
                  onClick={() =>
                    setLines((prev) =>
                      prev.length === 1
                        ? [blankLine()]
                        : prev.filter((x) => x.key !== l.key),
                    )
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setLines((prev) => [...prev, blankLine()])}
            >
              <Plus className="size-3.5" />
              Add line
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="milestone-total">Recorded total</Label>
            <Input
              id="milestone-total"
              inputMode="decimal"
              placeholder={(computedCents / 100).toFixed(2)}
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              className="tabular-nums"
            />
            <p className="text-muted-foreground text-xs">
              Lines add to {formatUSD(computedCents)}. Leave blank to use that, or
              enter the figure you actually wrote down.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="milestone-goal">Goal for next month</Label>
              <Input
                id="milestone-goal"
                placeholder="$10k"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="milestone-note">Note</Label>
              <Input
                id="milestone-note"
                placeholder="Optional"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add checkpoint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
