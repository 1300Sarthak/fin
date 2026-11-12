"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Segmented } from "@/components/kit";

/** How far ahead to look. Forward-looking, so it is days rather than the RangePicker's past periods. */
export function WindowPicker({ value, windows }: { value: number; windows: readonly number[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <Segmented
      aria-label="Look ahead"
      options={windows.map((w) => ({ value: String(w), label: `${w} days` }))}
      value={String(value)}
      onValueChange={(v) => {
        const next = new URLSearchParams(params.toString());
        if (v === String(windows[0])) next.delete("days"); else next.set("days", v);
        const qs = next.toString();
        router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }}
    />
  );
}
