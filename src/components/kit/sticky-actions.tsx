import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A save bar pinned to the bottom of the viewport while a form has unsaved
 * changes. Render it inside the <form>; it drops in when `show` turns true.
 */
export function StickyActions({ show, message, children, className }: { show: boolean; message?: ReactNode; children: ReactNode; className?: string }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none sticky bottom-4 z-30 mt-6 flex justify-center px-2">
      <div role="region" aria-label="Unsaved changes" className={cn("drop-in bg-popover text-popover-foreground pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-xl border py-2 pr-2 pl-4 shadow-[var(--shadow-pop)]", className)}>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">{message ?? "Unsaved changes"}</span>
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      </div>
    </div>
  );
}
