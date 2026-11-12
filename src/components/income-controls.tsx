"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Segmented, ToggleChip } from "@/components/kit";
import { cn } from "@/lib/utils";

const GROUPS = [{ value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" }, { value: "year", label: "Year" }] as const;
const BASES = [{ value: "paid", label: "When paid" }, { value: "work", label: "When worked" }] as const;
type Group = (typeof GROUPS)[number]["value"];
type Basis = (typeof BASES)[number]["value"];

/**
 * Group-by, basis and which jobs to include. The URL is the state (`by`,
 * `basis`, `src=A,B`), so the server page and the CLI read the same thing.
 */
export function IncomeControls({ by, basis, sources, selected }: { by: Group; basis: Basis; sources: string[]; selected: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  function set(key: string, value: string | null, fallback?: string) {
    const next = new URLSearchParams(params.toString());
    if (value == null || value === fallback) next.delete(key); else next.set(key, value);
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }
  const all = selected.length === 0;
  const toggle = (name: string, on: boolean) => {
    const current = all ? sources : selected;
    const next = on ? [...current, name] : current.filter((s) => s !== name);
    set("src", next.length === 0 || next.length === sources.length ? null : next.join(","));
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-3 transition-opacity", pending && "opacity-60")} aria-busy={pending}>
      <Segmented aria-label="Group by" options={GROUPS} value={by} onValueChange={(v) => set("by", v, "month")} />
      <Segmented aria-label="Count income" options={BASES} value={basis} onValueChange={(v) => set("basis", v, "paid")} />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Jobs">
        {sources.map((name) => (
          <ToggleChip key={name} pressed={all || selected.includes(name)} onPressedChange={(on) => toggle(name, on)}>{name}</ToggleChip>
        ))}
      </div>
    </div>
  );
}
