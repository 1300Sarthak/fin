"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarDays, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { ResponsiveSheet } from "@/components/kit";
import { SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SelectCategory } from "@/lib/queries";
import type { getCashActivity } from "@/lib/cash";
import { formatSigned, formatDate, isoDate, toDollars } from "@/lib/format";
import { cn } from "@/lib/utils";

type CashTxn = Awaited<ReturnType<typeof getCashActivity>>[number];
type Direction = "spend" | "add";
type FormState = {
  direction: Direction;
  date: string;
  amount: string;
  categoryId: string;
  note: string;
};

const today = () => isoDate(new Date());

function stateFromTxn(txn: CashTxn): FormState {
  return {
    direction: txn.amountCents < 0 ? "spend" : "add",
    date: isoDate(txn.postedAt),
    amount: Math.abs(toDollars(txn.amountCents)).toFixed(2),
    categoryId: txn.categoryId ? String(txn.categoryId) : "",
    note: txn.note ?? txn.merchantRaw ?? "",
  };
}

function emptyState(): FormState {
  return {
    direction: "spend",
    date: today(),
    amount: "",
    categoryId: "",
    note: "",
  };
}

function CategoryField({
  value,
  categories,
  onChange,
  id,
}: {
  value: string;
  categories: SelectCategory[];
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
    >
      <option value="">Uncategorized</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.isChild ? `  ${c.name}` : c.name}
        </option>
      ))}
    </select>
  );
}

function DirectionField({
  value,
  onChange,
  id,
}: {
  value: Direction;
  onChange: (value: Direction) => void;
  id: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as Direction)}
      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
    >
      <option value="spend">Spent</option>
      <option value="add">Added</option>
    </select>
  );
}

export function CashActivityEditor({
  activity,
  categories,
}: {
  activity: CashTxn[];
  categories: SelectCategory[];
}) {
  const router = useRouter();
  const [form, setForm] = React.useState<FormState>(() => emptyState());
  const [editing, setEditing] = React.useState<CashTxn | null>(null);
  const [editForm, setEditForm] = React.useState<FormState>(() => emptyState());
  const [busy, setBusy] = React.useState(false);

  function patchForm(patch: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function patchEditForm(patch: Partial<FormState>) {
    setEditForm((prev) => ({ ...prev, ...patch }));
  }

  async function saveNew(e: React.FormEvent) {
    e.preventDefault();
    await save("/api/cash", "POST", form, () => setForm(emptyState()));
  }

  async function saveEdit() {
    if (!editing) return;
    await save("/api/cash", "PUT", editForm, () => setEditing(null), editing.id);
  }

  async function save(
    url: string,
    method: "POST" | "PUT",
    state: FormState,
    onSuccess: () => void,
    id?: number,
  ) {
    const amount = Number(state.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an amount first");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          direction: state.direction,
          date: state.date,
          amount,
          categoryId: state.categoryId || null,
          note: state.note,
        }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save cash entry");
      toast.success(data.message ?? "Saved");
      onSuccess();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save cash entry");
    } finally {
      setBusy(false);
    }
  }

  async function remove(txn: CashTxn) {
    if (!window.confirm("Delete this cash entry?")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/cash", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txn.id }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't delete cash entry");
      toast.success(data.message ?? "Deleted");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete cash entry");
    } finally {
      setBusy(false);
    }
  }

  function openEdit(txn: CashTxn) {
    setEditing(txn);
    setEditForm(stateFromTxn(txn));
  }

  return (
    <div className="space-y-5">
      <form
        onSubmit={saveNew}
        className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-[8rem_9rem_9rem_minmax(12rem,1fr)_auto]"
      >
        <div className="space-y-1.5">
          <Label htmlFor="cash-entry-direction" className="text-xs">
            Type
          </Label>
          <DirectionField
            id="cash-entry-direction"
            value={form.direction}
            onChange={(direction) => patchForm({ direction })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cash-entry-date" className="text-xs">
            Date
          </Label>
          <Input
            id="cash-entry-date"
            type="date"
            value={form.date}
            onChange={(e) => patchForm({ date: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cash-entry-amount" className="text-xs">
            Amount
          </Label>
          <Input
            id="cash-entry-amount"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => patchForm({ amount: e.target.value })}
            placeholder="0.00"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cash-entry-note" className="flex items-center gap-1 text-xs">
            <Sparkles className="size-3" />
            AI note
          </Label>
          <Input
            id="cash-entry-note"
            value={form.note}
            onChange={(e) => patchForm({ note: e.target.value })}
            placeholder="Lunch, groceries, ATM withdrawal"
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={busy} className="w-full md:w-auto">
            <Plus className="size-4" />
            Add
          </Button>
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor="cash-entry-category" className="text-xs">
            Category
          </Label>
          <CategoryField
            id="cash-entry-category"
            value={form.categoryId}
            categories={categories}
            onChange={(categoryId) => patchForm({ categoryId })}
          />
        </div>
      </form>

      {activity.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No cash activity yet. Add a cash entry above.
        </p>
      ) : (
        <div className="divide-y">
          {activity.map((t) => (
            <div
              key={t.id}
              className="grid gap-3 py-3 text-sm sm:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.5fr)_minmax(8rem,1fr)_auto]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <CalendarDays className="size-3.5" />
                  {formatDate(t.postedAt)}
                </div>
                <div className="mt-1 font-medium">{t.amountCents < 0 ? "Spent" : "Added"}</div>
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{t.note || t.merchantRaw}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {t.category?.name ?? "Uncategorized"}
                </div>
              </div>
              <div
                className={cn(
                  "font-medium tabular-nums sm:text-right",
                  t.amountCents >= 0 ? "text-positive" : "",
                )}
              >
                {formatSigned(t.amountCents)}
              </div>
              <div className="flex gap-2 sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Edit cash entry"
                  disabled={busy}
                  onClick={() => openEdit(t)}
                  className="cursor-pointer"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Delete cash entry"
                  disabled={busy}
                  onClick={() => remove(t)}
                  className="cursor-pointer"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bottom sheet on phones (thumb reach), side sheet from tablet up. */}
      <ResponsiveSheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <div className="space-y-4 px-4 pt-3 pb-5 md:px-5 md:pt-5">
          <SheetTitle className="pr-8 text-[15px] font-semibold">Edit cash entry</SheetTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-cash-direction">Type</Label>
              <DirectionField
                id="edit-cash-direction"
                value={editForm.direction}
                onChange={(direction) => patchEditForm({ direction })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-cash-date">Date</Label>
              <Input
                id="edit-cash-date"
                type="date"
                value={editForm.date}
                onChange={(e) => patchEditForm({ date: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-cash-amount">Amount</Label>
              <Input
                id="edit-cash-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={editForm.amount}
                onChange={(e) => patchEditForm({ amount: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-cash-category">Category</Label>
              <CategoryField
                id="edit-cash-category"
                value={editForm.categoryId}
                categories={categories}
                onChange={(categoryId) => patchEditForm({ categoryId })}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="edit-cash-note" className="flex items-center gap-1">
                <Sparkles className="size-3.5" />
                AI note
              </Label>
              <textarea
                id="edit-cash-note"
                value={editForm.note}
                onChange={(e) => patchEditForm({ note: e.target.value })}
                rows={3}
                placeholder="What was this cash for?"
                className="border-input dark:bg-input/30 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] md:text-sm"
              />
            </div>
          </div>
          <Button onClick={saveEdit} disabled={busy} className="w-full sm:w-auto">
            {busy ? "Saving..." : "Save entry"}
          </Button>
        </div>
      </ResponsiveSheet>
    </div>
  );
}
