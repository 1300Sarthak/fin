"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

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

  function set(v: string) {
    const params = new URLSearchParams(sp.toString());
    if (defaultValue !== undefined && v === defaultValue) params.delete(paramKey);
    else params.set(paramKey, v);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="bg-muted/40 inline-flex items-center gap-0.5 rounded-lg border p-0.5">
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="xs"
          variant={o.value === value ? "secondary" : "ghost"}
          onClick={() => set(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
