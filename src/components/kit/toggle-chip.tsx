"use client";

import type { ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/** An on/off choice shown as a pill. Use for "applies to me" sets, not settings. */
export function ToggleChip({ pressed, onPressedChange, children, className }: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "pressable inline-flex min-h-9 items-center gap-1.5 rounded-full border py-1.5 pr-3.5 pl-2.5 text-left text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "border-brand/50 bg-brand/10 text-foreground" : "text-muted-foreground hover:border-foreground/20 hover:text-foreground",
        className,
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {pressed ? <Check key="on" className="drop-in text-brand size-3.5" aria-hidden="true" /> : <Plus key="off" className="size-3.5 opacity-60" aria-hidden="true" />}
      </span>
      {children}
    </button>
  );
}
