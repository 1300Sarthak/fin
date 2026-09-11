"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Delete a goal (children are reparented to top-level by the API). */
export function GoalDeleteButton({ id, name }: { id: number; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function remove() {
    if (!window.confirm(`Delete "${name}"? Any sub-goals become top-level.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      toast.success("Goal deleted");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="icon-sm" onClick={remove} disabled={busy} aria-label="Delete goal">
      <Trash2 className="size-4" />
    </Button>
  );
}
