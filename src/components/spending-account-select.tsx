"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";

/** Narrows the spending page to one account via `?account=`, keeping the range. */
export function SpendingAccountSelect({ accounts }: { accounts: { id: number; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  if (accounts.length === 0) return null;
  return (
    <span className="relative inline-flex">
      <select
        aria-label="Account"
        value={params.get("account") ?? ""}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          if (e.target.value) next.set("account", e.target.value); else next.delete("account");
          const qs = next.toString();
          router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        }}
        className="border-input bg-background hover:bg-muted dark:bg-input/30 h-8 max-w-[13rem] appearance-none truncate rounded-lg border pr-7 pl-2.5 text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-[13px]"
      >
        <option value="">All accounts</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <ChevronDown className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2" aria-hidden="true" />
    </span>
  );
}
