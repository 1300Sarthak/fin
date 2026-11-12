"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/kit";
import { cn } from "@/lib/utils";

/** The tax-year picker for Business & 1099: the URL's `year`, the current year when absent. */
export function BusinessYearPicker({ year, years, current }: { year: number; years: number[]; current: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const options = years.map((y) => ({ value: String(y), label: `${y}` }));
  return (
    <Segmented
      aria-label="Tax year"
      options={options}
      value={String(year)}
      className={cn(pending && "opacity-70")}
      onValueChange={(v) => {
        const next = new URLSearchParams(params.toString());
        if (Number(v) === current) next.delete("year"); else next.set("year", v);
        const qs = next.toString();
        start(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
      }}
    />
  );
}
