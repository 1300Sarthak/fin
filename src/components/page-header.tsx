import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Page title, one line of description, and the page's actions on the right.
 * `children` and `actions` are the same slot (children kept for older pages).
 * Keep the description to one sentence; detail belongs in the page.
 */
export function PageHeader({ title, description, actions, children, className }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const slot = actions ?? children;
  return (
    <div className={cn("mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}>
      <div className="min-w-0">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-balance">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 max-w-[62ch] text-sm text-pretty">{description}</p>}
      </div>
      {slot && <div className="flex flex-wrap items-center gap-2">{slot}</div>}
    </div>
  );
}
