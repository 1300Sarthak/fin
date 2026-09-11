"use client";

import * as React from "react";
import { Repeat } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DetectRecurringButton() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  async function run() {
    setLoading(true);
    const t = toast.loading("Scanning for recurring charges…");
    try {
      const res = await fetch("/api/recurring/detect", { method: "POST" });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Detection failed");
      toast.success(data.message ?? "Done", { id: t });
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Detection failed", { id: t });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={run} disabled={loading} variant="outline" size="sm">
      <Repeat className={cn("size-4", loading && "animate-spin")} />
      {loading ? "Scanning…" : "Detect recurring"}
    </Button>
  );
}
