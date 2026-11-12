"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Segmented, ToggleChip, inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";

export type HistoryView = "timeline" | "securities" | "funding";
const VIEWS = [
  { value: "timeline", label: "Timeline" },
  { value: "securities", label: "By security" },
  { value: "funding", label: "Funding" },
] as const;

/**
 * The URL is the state for the purchase history: `view`, `account`, `symbol`,
 * `kind`, `all`. Other params (the range) are kept as they are.
 */
export function HistoryControls({ view, account, symbol, kind, all, hidden, accounts, symbols, kinds }: {
  view: HistoryView;
  account: number | null;
  symbol: string | null;
  kind: string | null;
  all: boolean;
  hidden: number;
  accounts: { id: number; name: string }[];
  symbols: string[];
  kinds: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();

  function set(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") next.delete(k); else next.set(k, v);
    }
    const qs = next.toString();
    startTransition(() => router.push(`${qs ? `${pathname}?${qs}` : pathname}#history`, { scroll: false }));
  }

  const select = cn(inputClass, "sm:w-auto sm:max-w-56");
  return (
    <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", pending && "opacity-60")}>
      <Segmented aria-label="History view" options={VIEWS} value={view} onValueChange={(v) => set({ view: v === "timeline" ? null : v })} />
      <select aria-label="Account" className={select} value={account ?? ""} onChange={(e) => set({ account: e.target.value || null })}>
        <option value="">All accounts</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select aria-label="Security" className={select} value={symbol ?? ""} onChange={(e) => set({ symbol: e.target.value || null })}>
        <option value="">All securities</option>
        {symbol && !symbols.includes(symbol) && <option value={symbol}>{symbol}</option>}
        {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {view === "timeline" && (
        <select aria-label="Kind" className={select} value={kind ?? ""} onChange={(e) => set({ kind: e.target.value || null })}>
          <option value="">Every kind</option>
          {kinds.map((k) => <option key={k} value={k}>{k.replace("-", " ")}</option>)}
        </select>
      )}
      {view === "timeline" && (hidden > 0 || all) && (
        <ToggleChip pressed={all} onPressedChange={(on) => set({ all: on ? "1" : null })}>
          {all ? "Showing sweep and duplicate rows" : `Show ${hidden} hidden row${hidden === 1 ? "" : "s"}`}
        </ToggleChip>
      )}
    </div>
  );
}
