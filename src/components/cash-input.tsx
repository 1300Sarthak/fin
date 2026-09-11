"use client";

import * as React from "react";
import { Sparkles, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CashInput() {
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update cash");
      toast.success(data.message ?? "Updated");
      setText("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update cash");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Describe a cash change in plain English"
          placeholder="e.g. “I have $200 in my wallet” or “spent $15 on lunch”"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !text.trim()}>
          <Send className="size-4" />
          {busy ? "…" : "Update"}
        </Button>
      </div>
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Sparkles className="size-3" />
        Type naturally — it figures out set / add / spend and updates your total.
      </p>
    </form>
  );
}
