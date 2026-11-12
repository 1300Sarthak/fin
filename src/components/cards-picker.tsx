"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { inputClass, ToggleChip } from "@/components/kit";
import { cn } from "@/lib/utils";

/** "Which card?" controls: a category and an abroad switch, both in the URL so the ranking renders on the server. */
export function CardsPicker({ category, categories, abroad }: { category: string; categories: string[]; abroad: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const write = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    start(() => router.replace(`${pathname}?${next}`, { scroll: false }));
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", pending && "opacity-70")}>
      <select aria-label="Purchase category" value={category} onChange={(e) => write({ category: e.target.value })} className={cn(inputClass, "w-auto min-w-[12rem] flex-1 sm:flex-none")}>
        {!categories.includes(category) && <option value={category}>{category}</option>}
        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <ToggleChip pressed={abroad} onPressedChange={(on) => write({ abroad: on ? "1" : null })}>Abroad</ToggleChip>
    </div>
  );
}
