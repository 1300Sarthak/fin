"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useIndicator } from "./use-indicator";

export type SegmentedOption<T extends string> = { value: T; label: React.ReactNode };

/** A small set of mutually exclusive views, with a thumb that slides between them. */
export function Segmented<T extends string>({ options, value, onValueChange, size = "sm", className, ...aria }: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: "xs" | "sm";
  className?: string;
  "aria-label": string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const box = useIndicator(ref, value);
  return (
    <div ref={ref} role="radiogroup" aria-label={aria["aria-label"]} className={cn("bg-muted/60 relative inline-flex items-center rounded-lg border p-0.5", className)}>
      {box && <span aria-hidden="true" className="nav-indicator bg-background dark:bg-accent absolute top-0.5 bottom-0.5 left-0 rounded-md shadow-sm ring-1 ring-foreground/5" style={{ width: box.width, transform: `translateX(${box.left}px)` }} />}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-active={active}
            onClick={() => onValueChange(o.value)}
            className={cn(
              "relative rounded-md font-medium whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
              size === "xs" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-[13px]",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              active && !box && "bg-background dark:bg-accent shadow-sm",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
