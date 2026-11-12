"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/kit";
import { cn } from "@/lib/utils";

/** Monthly or weekly periods, as `?by=week` (the selected period resets). */
export function HistoryBy({ value }: { value: "month" | "week" }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  return (
    <Segmented
      aria-label="Period length"
      className={cn(pending && "opacity-70")}
      options={[{ value: "month", label: "Monthly" }, { value: "week", label: "Weekly" }]}
      value={value}
      onValueChange={(v) => {
        const next = new URLSearchParams(params.toString());
        next.delete("at");
        if (next.get("period") === "week") next.delete("period");
        if (v === "week") next.set("by", "week"); else next.delete("by");
        const qs = next.toString();
        start(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
      }}
    />
  );
}
