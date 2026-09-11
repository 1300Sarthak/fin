"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Per-account "counts toward totals" switch. Persists `accounts.isActive`, which
 * every total/dropdown already filters on, so toggling it off permanently hides
 * the account from net worth (distinct from the ephemeral live multiselect).
 */
export function AccountActiveToggle({ id, isActive }: { id: number; isActive: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function onChange(checked: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isActive: checked }),
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
    <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs">
      <Checkbox checked={isActive} onCheckedChange={onChange} disabled={busy} />
      Counts
    </label>
  );
}
