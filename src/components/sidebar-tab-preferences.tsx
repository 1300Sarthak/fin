"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { NAV_ITEMS } from "@/components/app-sidebar";
import { Checkbox } from "@/components/ui/checkbox";

export function SidebarTabPreferences({ initialVisibleTabs }: { initialVisibleTabs: string[] }) {
  const router = useRouter();
  const [visibleTabs, setVisibleTabs] = React.useState(() => new Set(initialVisibleTabs));
  const [busy, setBusy] = React.useState(false);

  async function update(id: string, checked: boolean) {
    const next = new Set(visibleTabs);
    if (checked) next.add(id); else next.delete(id);
    setVisibleTabs(next);
    setBusy(true);
    try {
      const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sidebarVisibleTabs: NAV_ITEMS.filter((item) => next.has(item.id)).map((item) => item.id) }) });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save sidebar preferences");
      router.refresh();
    } catch (error) {
      setVisibleTabs(new Set(initialVisibleTabs));
      toast.error(error instanceof Error ? error.message : "Could not save sidebar preferences");
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid gap-1 sm:grid-cols-2">
    {NAV_ITEMS.map(({ id, label, icon: Icon }) => <label key={id} className="hover:bg-muted flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors">
      <Checkbox checked={visibleTabs.has(id)} onCheckedChange={(checked) => update(id, checked === true)} disabled={busy} />
      <Icon className="text-muted-foreground size-4" aria-hidden="true" />
      <span>{label}</span>
    </label>)}
  </div>;
}
