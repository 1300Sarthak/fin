"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { inputClass } from "@/components/kit";
import { cn } from "@/lib/utils";

/** Account and symbol filters for /holdings; the URL (`account`, `symbol`) is the state. */
export function HoldingsFilters({ account, symbol, accounts, symbols }: {
  account: number | null;
  symbol: string | null;
  accounts: { id: number; name: string }[];
  symbols: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = React.useTransition();
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v); else next.delete(k);
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  const select = cn(inputClass, "sm:w-auto sm:max-w-56");
  return (
    <div className={cn("flex flex-wrap gap-2 transition-opacity", pending && "opacity-60")}>
      <select aria-label="Account" className={select} value={account ?? ""} onChange={(e) => set("account", e.target.value)}>
        <option value="">All accounts</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select aria-label="Symbol" className={select} value={symbol ?? ""} onChange={(e) => set("symbol", e.target.value)}>
        <option value="">All symbols</option>
        {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}
