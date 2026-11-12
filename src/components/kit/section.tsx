import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled group of content. Plain by default (a heading and space, no box);
 * `surface` puts the body on a card when it needs separating from the page.
 */
export function Section({ title, description, actions, children, surface = false, className, bodyClassName, id }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  surface?: boolean;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("min-w-0 scroll-mt-28", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>}
            {description && <p className="text-muted-foreground mt-0.5 max-w-[65ch] text-[13px] text-pretty">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(surface && "bg-card rounded-xl border", bodyClassName)}>{children}</div>
    </section>
  );
}
