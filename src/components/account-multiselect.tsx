"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/**
 * A dropdown of account checkboxes that live-filters which accounts count toward
 * the total, via an `?accounts=` URL param (ephemeral — resets when navigating
 * away). `included` seeds the checked state from the server-resolved set, so it
 * reflects the persistent hide-cash baseline on first paint.
 *
 * - Toggling writes an explicit override list (hide-cash pref ignored).
 * - "Reset to default" removes the param → falls back to the persistent baseline.
 */
export function AccountMultiselect({
  accounts,
  included,
}: {
  accounts: { id: number; name: string }[];
  included: number[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const set = new Set(included);

  function writeParam(next: Set<number> | null) {
    const params = new URLSearchParams(sp.toString());
    if (next === null) params.delete("accounts");
    else params.set("accounts", [...next].join(","));
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function toggle(id: number, checked: boolean) {
    const next = new Set(set);
    if (checked) next.add(id);
    else next.delete(id);
    writeParam(next);
  }

  if (accounts.length === 0) return null;
  const label = set.size === accounts.length ? "All accounts" : `${set.size} of ${accounts.length}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm">
            <SlidersHorizontal className="size-4" />
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => writeParam(null)}>Reset to default</DropdownMenuItem>
        <DropdownMenuItem onClick={() => writeParam(new Set(accounts.map((a) => a.id)))}>
          Select all
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => writeParam(new Set())}>Clear</DropdownMenuItem>
        <DropdownMenuSeparator />
        {accounts.map((a) => (
          <DropdownMenuCheckboxItem
            key={a.id}
            checked={set.has(a.id)}
            onCheckedChange={(checked) => toggle(a.id, checked)}
          >
            {a.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
