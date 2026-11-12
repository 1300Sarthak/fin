"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Explanatory text behind a small (i). Opens on hover with a mouse and on tap
 * with a finger, so help never has to sit under every field.
 */
export function HelpTip({ children, label = "More information", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={150} aria-label={label} className={cn("text-muted-foreground/70 hover:text-foreground inline-grid size-5 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", className)}>
        <Info className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="top" className="max-w-72 text-[13px] leading-relaxed text-pretty">{children}</PopoverContent>
    </Popover>
  );
}
