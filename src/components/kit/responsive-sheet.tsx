"use client";

import * as React from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const QUERY = "(min-width: 768px)";
const subscribe = (fn: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", fn);
  return () => m.removeEventListener("change", fn);
};

/** True from tablet width up; false on the server and on phones. */
export function useWide(): boolean {
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}

/**
 * Detail panel for a card, program, or transaction: a side sheet on wide
 * screens, a bottom sheet with a grab handle on phones (where a thumb reaches
 * it). Content scrolls inside, never the page behind it.
 */
export function ResponsiveSheet({ open, onOpenChange, children, className }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const wide = useWide();
  // Focus lands on the top of the sheet, so a long one opens at its start rather than scrolled to its first link.
  const top = React.useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={wide ? "right" : "bottom"}
        initialFocus={top}
        style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)", transitionDuration: wide ? "220ms" : "320ms" }}
        className={cn(
          "gap-0 overflow-y-auto overscroll-contain",
          wide ? "w-full sm:max-w-md" : "max-h-[88dvh] rounded-t-2xl border-t pb-[env(safe-area-inset-bottom,0px)]",
          className,
        )}
      >
        <div ref={top} tabIndex={-1} className="outline-none" />
        {!wide && <div aria-hidden="true" className="bg-muted-foreground/30 mx-auto mt-2 h-1 w-10 shrink-0 rounded-full" />}
        {children}
      </SheetContent>
    </Sheet>
  );
}
