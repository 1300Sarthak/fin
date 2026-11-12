"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { RANGE_PRESETS, yearRange, type RangePreset, type ResolvedRange } from "./range";
import { RangeCalendar } from "./range-calendar";
import { ResponsiveSheet, useWide } from "./responsive-sheet";

type Choice = { key: string; label: string; active: boolean; apply: () => void };

/**
 * Period picker that writes `period`/`from`/`to` to the URL, so the server page
 * reads the same range with `resolveRange(await searchParams)`. Pass the
 * resolved range back in as `value`; selecting `fallback` clears the params.
 * Presets and year shortcuts on the side, a two-month calendar beside them; on
 * phones a bottom sheet with one swipeable month.
 */
export function RangePicker({ value, prefix = "", fallback = "this-month", presets = RANGE_PRESETS.map((p) => p.value), years = 2, className }: {
  value: ResolvedRange;
  prefix?: string;
  fallback?: Exclude<RangePreset, "custom">;
  presets?: readonly Exclude<RangePreset, "custom">[];
  /** How many calendar-year shortcuts to offer (this year and back); 0 hides them. */
  years?: number;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wide = useWide();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const key = (k: string) => (prefix ? `${prefix}${k[0].toUpperCase()}${k.slice(1)}` : k);

  function go(preset: RangePreset, range?: { from: string; to: string }) {
    const next = new URLSearchParams(params.toString());
    for (const k of ["period", "from", "to"]) next.delete(key(k));
    if (preset !== fallback) next.set(key("period"), preset);
    if (preset === "custom" && range) { next.set(key("from"), range.from); next.set(key("to"), range.to); }
    const qs = next.toString();
    setOpen(false);
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  const thisYear = new Date().getFullYear();
  const choices: Choice[] = [
    ...presets.map((p) => ({ key: p, label: RANGE_PRESETS.find((r) => r.value === p)!.label, active: value.preset === p, apply: () => go(p) })),
    ...Array.from({ length: years }, (_, i) => {
      const y = yearRange(thisYear - i);
      return { key: String(thisYear - i), label: String(thisYear - i), active: value.preset === "custom" && value.from === y.from && value.to === y.to, apply: () => go("custom", y) };
    }),
  ];

  const list = (
    <div role="listbox" aria-label="Date range presets" className={cn("grid gap-0.5", wide ? "content-start" : "grid-cols-2")}>
      {choices.map((c) => (
        <button key={c.key} type="button" role="option" aria-selected={c.active} onClick={c.apply} className={cn("hoverable flex w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] whitespace-nowrap", wide ? "h-8" : "h-11 text-sm", c.active && "bg-brand/10 font-medium")}>
          {c.label}
          {c.active && <Check className="text-brand size-3.5 shrink-0" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
  const calendar = <RangeCalendar months={wide ? 2 : 1} from={value.from} to={value.to} onSelect={(r) => go("custom", r)} />;

  const trigger = (
    <>
      <CalendarRange className={cn("text-muted-foreground size-3.5", pending && "opacity-0")} aria-hidden="true" />
      {pending && <span aria-hidden="true" className="border-muted-foreground/40 border-t-foreground absolute left-2.5 size-3.5 animate-spin rounded-full border-[1.5px]" />}
      <span className="num">{value.label}</span>
      <ChevronDown className="text-muted-foreground size-3.5" aria-hidden="true" />
      {/* Route is loading the new range: a thin indeterminate bar under the label. */}
      {pending && <span aria-hidden="true" className="range-progress bg-brand/70 absolute inset-x-2 -bottom-px h-0.5 rounded-full" />}
    </>
  );
  const triggerClass = cn("relative gap-1.5 overflow-hidden font-medium", className);

  if (!wide) {
    return (
      <>
        <Button variant="outline" size="sm" className={triggerClass} aria-busy={pending} aria-haspopup="dialog" onClick={() => setOpen(true)}>{trigger}</Button>
        <ResponsiveSheet open={open} onOpenChange={setOpen}>
          <div className="space-y-4 px-4 pt-3 pb-5">
            <SheetTitle className="text-[15px] font-semibold">Date range</SheetTitle>
            {list}
            <div className="border-t pt-3">{calendar}</div>
          </div>
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className={triggerClass} aria-busy={pending} />}>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="flex w-auto gap-3 p-2">
        <div className="w-36 shrink-0 border-r pr-2">{list}</div>
        <div className="w-[min(30rem,calc(100vw-14rem))] p-1">{calendar}</div>
      </PopoverContent>
    </Popover>
  );
}
