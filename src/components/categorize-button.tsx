"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CategorizeButton() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  async function run() {
    setLoading(true);
    const t = toast.loading("Categorizing…");
    try {
      const res = await fetch("/api/categorize", { method: "POST" });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Categorize failed");
      toast.success(data.message ?? "Done", { id: t });
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Categorize failed", { id: t });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={run} disabled={loading} variant="outline" size="sm">
      <Sparkles className={cn("size-4", loading && "animate-pulse")} />
      {loading ? "Categorizing…" : "Categorize"}
    </Button>
  );
}
