"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Op = "set" | "add" | "subtract";

export function CashControls() {
  const router = useRouter();
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<Op | null>(null);

  async function run(op: Op) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter an amount first");
      return;
    }
    setBusy(op);
    try {
      const res = await fetch("/api/cash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, amount: amt, note }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update cash");
      toast.success(data.message ?? "Updated");
      setAmount("");
      setNote("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update cash");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="cash-amount" className="text-xs">
            Amount
          </Label>
          <div className="relative">
            <span className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2 text-sm">
              $
            </span>
            <Input
              id="cash-amount"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-40 pl-7"
            />
          </div>
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="cash-note" className="text-xs">
            Note (optional)
          </Label>
          <Input
            id="cash-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. lunch, ATM withdrawal"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run("set")} disabled={busy !== null}>
          <Check className="size-4" />
          Set balance
        </Button>
        <Button onClick={() => run("add")} disabled={busy !== null} variant="outline">
          <Plus className="size-4" />
          Add cash
        </Button>
        <Button
          onClick={() => run("subtract")}
          disabled={busy !== null}
          variant="outline"
        >
          <Minus className="size-4" />
          Spend
        </Button>
      </div>
    </div>
  );
}
