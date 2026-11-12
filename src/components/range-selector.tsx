"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useNetWorthRange } from "@/components/net-worth-range";

export type RangeOption = { value: string; label: string };

/**
 * A segmented control that writes the selected value to a URL param, preserving
 * other params (mirrors AccountFilter). Selecting `defaultValue` removes the
 * param for a clean URL. Reused for net-worth ranges and transaction windows.
 */
export function RangeSelector({
  options,
  value,
  paramKey = "range",
  defaultValue,
}: {
  options: RangeOption[];
  value: string;
  paramKey?: string;
  defaultValue?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // Inside a NetWorthRangeProvider the pick shows at once; the URL follows.
  const shared = useNetWorthRange();
  const [, startTransition] = useTransition();
  const selected = shared?.value ?? value;

  function set(v: string) {
    shared?.set(v);
    const params = new URLSearchParams(sp.toString());
    if (defaultValue !== undefined && v === defaultValue) params.delete(paramKey);
    else params.set(paramKey, v);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  return (
    <div className="bg-muted/40 inline-flex items-center gap-0.5 rounded-lg border p-0.5">
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="xs"
          variant={o.value === selected ? "secondary" : "ghost"}
          aria-pressed={o.value === selected}
          onClick={() => set(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
