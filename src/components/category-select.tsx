"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { SelectCategory } from "@/lib/queries";

export function CategorySelect({
  txnId,
  value,
  categories,
}: {
  txnId: number;
  value: number | null;
  categories: SelectCategory[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const categoryId = Number(e.target.value);
    if (!categoryId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/transactions/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: txnId, categoryId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      toast.success("Category updated — similar transactions will follow");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      value={value ?? ""}
      onChange={onChange}
      disabled={busy}
      aria-label="Category"
      className="text-foreground hover:border-input w-full max-w-[14rem] truncate rounded-md border border-transparent bg-transparent py-1 pr-1 text-xs outline-none disabled:opacity-50"
    >
      <option value="" disabled>
        Uncategorized
      </option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.isChild ? `  ${c.name}` : c.name}
        </option>
      ))}
    </select>
  );
}
