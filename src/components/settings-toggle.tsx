"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";

/** A labeled persistent toggle that POSTs `{ [field]: checked }` to /api/config. */
export function SettingsToggle({
  field,
  checked,
  label,
  description,
}: {
  field: string;
  checked: boolean;
  label: string;
  description?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function onChange(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-muted-foreground mt-0.5 text-xs">{description}</div>}
      </div>
      <Checkbox checked={checked} onCheckedChange={onChange} disabled={busy} className="mt-0.5" />
    </label>
  );
}
