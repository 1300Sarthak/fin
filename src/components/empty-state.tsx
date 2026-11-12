import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({ icon: Icon, title, description, action, className }: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rise flex flex-col items-center justify-center rounded-xl border border-dashed px-4 py-14 text-center sm:px-12", className)}>
      {Icon && (
        <div className="bg-card text-muted-foreground mb-4 grid size-11 place-items-center rounded-xl border shadow-sm">
          <Icon className="size-5" aria-hidden="true" />
        </div>
      )}
      <h2 className="text-[15px] font-semibold text-balance">{title}</h2>
      {description && <p className="text-muted-foreground mt-1.5 max-w-md text-sm text-pretty">{description}</p>}
      {action && <div className="mt-5 flex w-full max-w-sm flex-col items-center gap-3">{action}</div>}
    </div>
  );
}
