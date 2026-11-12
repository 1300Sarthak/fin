"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Field, MoneyInput, ToggleChip, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";

export type EditorCategory = { id: number; name: string; parentId: number | null };
export type EditorGroup = { id: number; name: string; limitCents: number; categoryIds: number[]; catchAll: boolean };

const PHONE = "(max-width: 767px)";
function subscribe(cb: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
/** Phones get a bottom sheet, larger screens a centred dialog. */
function useIsPhone() {
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches, () => false);
}

/**
 * Create or edit one budget group. Categories another group already counts are
 * shown but locked, so totals never double count; picking a parent covers its
 * children.
 */
export function BudgetGroupEditor({ open, onOpenChange, group, groups, categories }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = new group. */
  group: EditorGroup | null;
  groups: EditorGroup[];
  categories: EditorCategory[];
}) {
  const phone = useIsPhone();
  const body = <EditorForm key={`${group?.id ?? "new"}-${open}`} group={group} groups={groups} categories={categories} onDone={() => onOpenChange(false)} />;
  const title = group ? `Edit ${group.name}` : "New budget";
  const description = "A monthly limit over a set of categories.";
  if (phone) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription>{description}</SheetDescription></SheetHeader>
          <div className="px-4">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function EditorForm({ group, groups, categories, onDone }: { group: EditorGroup | null; groups: EditorGroup[]; categories: EditorCategory[]; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(group?.name ?? "");
  const [limit, setLimit] = React.useState(group ? group.limitCents / 100 : 0);
  const [catchAll, setCatchAll] = React.useState(group?.catchAll ?? false);
  const [picked, setPicked] = React.useState<Set<number>>(new Set(group?.categoryIds ?? []));
  const [busy, setBusy] = React.useState(false);

  const otherCatchAll = groups.find((g) => g.catchAll && g.id !== group?.id);
  const parents = categories.filter((c) => c.parentId == null);
  const childrenOf = (id: number) => categories.filter((c) => c.parentId === id);
  // Which other group owns a category, directly or through its parent.
  const ownerOf = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const g of groups) {
      if (g.id === group?.id || g.catchAll) continue;
      for (const id of g.categoryIds) {
        m.set(id, g.name);
        categories.filter((c) => c.parentId === id).forEach((c) => m.set(c.id, g.name));
      }
    }
    return m;
  }, [groups, group, categories]);

  const toggle = (id: number, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      // A parent covers its children; listing both is redundant.
      if (on) childrenOf(id).forEach((c) => next.delete(c.id));
      return next;
    });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/budgets/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(group ? { id: group.id } : {}), name: name.trim(), limitCents: Math.round(limit * 100), catchAll, categoryIds: catchAll ? [] : [...picked] }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save the budget.");
      toast.success(group ? "Budget saved" : "Budget added");
      onDone();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the budget.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!group) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/budgets/groups?id=${group.id}`, { method: "DELETE" });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not delete the budget.");
      toast.success(`Deleted ${group.name}`);
      onDone();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the budget.");
    } finally {
      setBusy(false);
    }
  }

  const invalid = !name.trim() || limit <= 0 || (!catchAll && picked.size === 0);

  return (
    <form onSubmit={save} className="space-y-5">
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="bg-name">
          <input id="bg-name" className={inputClass} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Food" required />
        </Field>
        <Field label="Monthly limit" htmlFor="bg-limit">
          <MoneyInput id="bg-limit" value={limit} onChange={setLimit} />
        </Field>
      </div>

      <div>
        <ToggleChip pressed={catchAll} onPressedChange={setCatchAll} className={cn(otherCatchAll && !catchAll && "pointer-events-none opacity-50")}>
          Everything else
        </ToggleChip>
        <p className="text-muted-foreground mt-1.5 text-xs">
          {otherCatchAll && !catchAll
            ? `"${otherCatchAll.name}" already covers everything else.`
            : "Covers every category no other budget does, uncategorized included."}
        </p>
      </div>

      {!catchAll && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-[13px] font-medium">Categories</legend>
          {parents.map((p) => {
            const kids = childrenOf(p.id);
            const parentOn = picked.has(p.id);
            const parentOwner = ownerOf.get(p.id);
            return (
              <div key={p.id} className="space-y-1.5">
                <ToggleChip pressed={parentOn} onPressedChange={(on) => toggle(p.id, on)} className={cn(parentOwner && "pointer-events-none opacity-50")}>
                  <span>
                    {p.name}
                    {kids.length > 0 && parentOn && <span className="text-muted-foreground font-normal"> and all within</span>}
                    {parentOwner && <span className="text-muted-foreground font-normal">, in {parentOwner}</span>}
                  </span>
                </ToggleChip>
                {kids.length > 0 && !parentOn && (
                  <div className="flex flex-wrap gap-1.5 pl-4">
                    {kids.map((c) => {
                      const owner = ownerOf.get(c.id);
                      return (
                        <ToggleChip key={c.id} pressed={picked.has(c.id)} onPressedChange={(on) => toggle(c.id, on)} className={cn("min-h-8 py-1 text-xs", owner && "pointer-events-none opacity-50")}>
                          <span>{c.name}{owner && <span className="text-muted-foreground font-normal">, in {owner}</span>}</span>
                        </ToggleChip>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      <FormActions>
        {group && <Button type="button" variant="ghost" className="text-negative mr-auto" disabled={busy} onClick={remove}>Delete</Button>}
        <Button type="submit" disabled={busy || invalid}>{busy ? "Saving…" : group ? "Save budget" : "Add budget"}</Button>
      </FormActions>
    </form>
  );
}

function FormActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 border-t pt-4">{children}</div>;
}
