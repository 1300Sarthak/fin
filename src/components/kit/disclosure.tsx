import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Progressive disclosure for advanced fields, fine print, and long help. A
 * native <details>, so it works without JavaScript and animates where the
 * browser can (see `details.disclosure` in globals.css).
 */
export function Disclosure({ summary, hint, children, defaultOpen = false, className }: {
  summary: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={cn("disclosure group", className)} open={defaultOpen || undefined}>
      <summary className="text-muted-foreground hover:text-foreground flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors select-none outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight data-chevron className="size-3.5 shrink-0 transition-transform duration-200" aria-hidden="true" />
        <span>{summary}</span>
        {hint && <span className="text-muted-foreground/80 ml-1 font-normal">{hint}</span>}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}
