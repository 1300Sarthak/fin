"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SyncButton({
  size = "sm",
}: {
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  async function sync() {
    setLoading(true);
    const t = toast.loading("Syncing accounts…");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      toast.success(data.message ?? "Accounts synced", { id: t });
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed", { id: t });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={sync} disabled={loading} size={size}>
      <RefreshCw className={cn("size-4", loading && "animate-spin")} />
      {loading ? "Syncing…" : "Sync now"}
    </Button>
  );
}
