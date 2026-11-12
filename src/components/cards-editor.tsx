"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";

export type CardEditRow = {
  id: number; name: string; baseRateBp: number; annualFeeCents: number;
  foreignFeeBp: number | null; accountId: number | null; note: string | null; active: boolean;
};

async function send(method: "POST" | "PATCH" | "DELETE", body: object, id?: number) {
  const res = await fetch(`/api/cards${id ? `?id=${id}` : ""}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }) });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save");
}

/** "3" -> 300 bp; blank -> null (only meaningful for the foreign fee, where null means unknown). */
const bp = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const draftOf = (c: CardEditRow) => ({
  base: String(c.baseRateBp / 100), fee: String(c.annualFeeCents / 100), fx: c.foreignFeeBp == null ? "" : String(c.foreignFeeBp / 100),
  account: c.accountId == null ? "" : String(c.accountId), note: c.note ?? "",
});

/** Edits the plain numbers; bonus categories go through `fin cards set --rate` or PATCH /api/cards. */
export function CardsEditor({ cards }: { cards: CardEditRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState(draftOf(cards[0] ?? { id: 0, name: "", baseRateBp: 100, annualFeeCents: 0, foreignFeeBp: null, accountId: null, note: null, active: true }));
  const [add, setAdd] = React.useState({ name: "", base: "" });
  const [busy, setBusy] = React.useState(false);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    try { await fn(); toast.success(done); router.refresh(); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not save"); return false; }
    finally { setBusy(false); }
  }

  async function save(c: CardEditRow) {
    const ok = await run(() => send("PATCH", {
      id: c.id, baseRateBp: bp(draft.base) ?? 0, annualFeeCents: Math.round(Number(draft.fee || 0) * 100), foreignFeeBp: bp(draft.fx),
      accountId: draft.account.trim() ? Number(draft.account) : null, note: draft.note,
    }), `${c.name} updated`);
    if (ok) setEditing(null);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() => send("POST", { name: add.name, baseRateBp: bp(add.base) ?? 100 }), `${add.name} added`);
    if (ok) setAdd({ name: "", base: "" });
  }

  const field = (k: keyof typeof draft, label: string, w = "w-24") => (
    <label className="text-muted-foreground flex items-center gap-1.5 text-xs">{label}
      <input aria-label={label} className={cn(inputClass, w, "sm:h-8")} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </label>
  );

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        {cards.map((c) => (
          <Button key={c.id} size="sm" variant={editing === c.id ? "default" : "outline"} onClick={() => { setEditing(editing === c.id ? null : c.id); setDraft(draftOf(c)); }}>
            Edit {c.name}
          </Button>
        ))}
      </div>
      {cards.filter((c) => c.id === editing).map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          {field("base", "Base %")}{field("fee", "Fee $/yr")}{field("fx", "FX % (blank = unknown)")}{field("account", "Account ID")}{field("note", "Note", "w-full sm:w-64")}
          <Button size="sm" disabled={busy} onClick={() => save(c)}>Save</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => send("PATCH", { id: c.id, active: !c.active }), `${c.name} ${c.active ? "deactivated" : "activated"}`)}>{c.active ? "Deactivate" : "Activate"}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm(`Delete ${c.name}?`)) run(() => send("DELETE", {}, c.id), `${c.name} deleted`).then((ok) => ok && setEditing(null)); }}>Delete</Button>
        </div>
      ))}
      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <input aria-label="New card name" placeholder="Add a card" className={cn(inputClass, "w-56 sm:h-8")} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
        <input aria-label="Base rate %" placeholder="base %" inputMode="decimal" className={cn(inputClass, "w-24 sm:h-8")} value={add.base} onChange={(e) => setAdd({ ...add, base: e.target.value })} />
        <Button size="sm" type="submit" disabled={busy || !add.name.trim()}>Add</Button>
      </form>
    </div>
  );
}
