"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { NAV_SECTIONS, visibleSections } from "@/components/kit/nav";
import { Checkbox } from "@/components/ui/checkbox";

/** Section-level switches; hidden sections stay reachable from search (⌘K). */
export function SidebarTabPreferences({ initialVisibleTabs }: { initialVisibleTabs: string[] }) {
  const router = useRouter();
  const initial = React.useMemo(() => new Set(visibleSections(initialVisibleTabs).map((s) => s.id)), [initialVisibleTabs]);
  const [visible, setVisible] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);

  async function update(id: string, checked: boolean) {
    const next = new Set(visible);
    if (checked) next.add(id); else next.delete(id);
    setVisible(next);
    setBusy(true);
    try {
      const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sidebarVisibleTabs: NAV_SECTIONS.filter((s) => next.has(s.id)).map((s) => s.id) }) });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save sidebar preferences");
      router.refresh();
    } catch (error) {
      setVisible(initial);
      toast.error(error instanceof Error ? error.message : "Could not save sidebar preferences");
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-1 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
    {NAV_SECTIONS.map(({ id, label, icon: Icon, routes }) => <label key={id} className="hoverable flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm">
      <Checkbox checked={visible.has(id)} onCheckedChange={(checked) => update(id, checked === true)} disabled={busy} />
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="text-muted-foreground block truncate text-xs">{routes.map((r) => r.label).join(", ")}</span>
      </span>
    </label>)}
  </div>;
}
