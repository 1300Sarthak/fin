"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { inputClass, Segmented, type ResolvedRange } from "@/components/kit";
import type { SelectCategory } from "@/lib/queries";
import type { TxnFilter } from "@/lib/txn-filter-core";
import { cn } from "@/lib/utils";

const KINDS = [
  { value: "all", label: "All" },
  { value: "expense", label: "Spending" },
  { value: "income", label: "Income" },
  { value: "cashflow", label: "Cash flow" },
  { value: "transfer", label: "Transfers" },
] as const;
type KindValue = (typeof KINDS)[number]["value"];

/**
 * Search, quick filters, and the active-filter chips. Every control writes the
 * URL (replace for typing, push for picks) so any filtered view can be linked.
 */
export function TxnToolbar({ filter, range, accounts, categories }: {
  filter: TxnFilter;
  range: ResolvedRange;
  accounts: { id: number; name: string }[];
  categories: SelectCategory[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = React.useState(filter.q ?? "");
  const [pending, startTransition] = React.useTransition();

  const write = React.useCallback((patch: Record<string, string | null>, mode: "push" | "replace" = "push") => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    next.delete("limit");
    const qs = next.toString();
    startTransition(() => router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }, [params, pathname, router]);

  // Typing filters as you go: a short pause, then the URL (and the server query) follows.
  React.useEffect(() => {
    if ((filter.q ?? "") === q) return;
    const t = setTimeout(() => write({ q: q.trim() || null }, "replace"), 250);
    return () => clearTimeout(t);
  }, [q, filter.q, write]);

  const account = accounts.find((a) => a.id === filter.account);
  const wanted = filter.category?.toLowerCase();
  const categoryValue = !wanted ? "" : wanted === "uncategorized" || wanted === "none" ? "Uncategorized" : categories.find((c) => c.name.toLowerCase() === wanted)?.name ?? "";
  type Chip = { key: string; label: string; clear: Record<string, null> };
  const chips = ([
    range.preset !== "all" ? { key: "date", label: range.label, clear: { period: null, from: null, to: null } } : null,
    filter.kind ? { key: "kind", label: KINDS.find((k) => k.value === filter.kind)!.label, clear: { kind: null } } : null,
    filter.category ? { key: "category", label: `Category: ${filter.category}`, clear: { category: null } } : null,
    filter.merchant ? { key: "merchant", label: `Merchant: ${filter.merchant}`, clear: { merchant: null } } : null,
    filter.account ? { key: "account", label: `Account: ${account?.name ?? `#${filter.account}`}`, clear: { account: null } } : null,
    filter.source ? { key: "source", label: `Income source: ${filter.source}`, clear: { source: null } } : null,
    filter.id ? { key: "id", label: `Transaction #${filter.id}`, clear: { id: null } } : null,
    filter.q ? { key: "q", label: `“${filter.q}”`, clear: { q: null } } : null,
  ] as (Chip | null)[]).filter((c) => c !== null);

  return (
    <div className={cn("space-y-3 transition-opacity", pending && "opacity-80")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search transactions"
            placeholder="Search description, memo, or note"
            className={cn(inputClass, "pl-9")}
          />
        </div>
        <Segmented<KindValue>
          aria-label="Kind"
          options={KINDS}
          value={filter.kind ?? "all"}
          onValueChange={(v) => write({ kind: v === "all" ? null : v })}
        />
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
        <select aria-label="Account" value={filter.account ?? ""} onChange={(e) => write({ account: e.target.value || null })} className={cn(inputClass, "min-w-0 sm:w-auto sm:max-w-[12rem]")}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select aria-label="Category" value={categoryValue} onChange={(e) => write({ category: e.target.value || null })} className={cn(inputClass, "min-w-0 sm:w-auto sm:max-w-[12rem]")}>
          <option value="">All categories</option>
          <option value="Uncategorized">Uncategorized</option>
          {categories.map((c) => <option key={c.id} value={c.name}>{c.isChild ? `  ${c.name}` : c.name}</option>)}
        </select>
        </div>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => { if (c.key === "q") setQ(""); write(c.clear); }}
              className="drop-in hoverable bg-card inline-flex h-7 items-center gap-1 rounded-full border pr-2 pl-3 text-[12.5px] font-medium"
              aria-label={`Remove filter ${c.label}`}
            >
              <span className="max-w-[22ch] truncate">{c.label}</span>
              <X className="text-muted-foreground size-3.5" aria-hidden="true" />
            </button>
          ))}
          {chips.length > 1 && (
            <button type="button" onClick={() => { setQ(""); startTransition(() => router.push(pathname, { scroll: false })); }} className="text-muted-foreground hover:text-foreground ml-1 text-[12.5px]">
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
