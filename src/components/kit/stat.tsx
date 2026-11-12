import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUSD } from "@/lib/format";
import { HelpTip } from "./help-tip";

/** A signed change in cents, as quiet coloured text with an arrow. */
export function DeltaText({ cents, label, className }: { cents: number; label?: string; className?: string }) {
  const up = cents >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("num inline-flex items-center gap-0.5 text-[13px] font-medium", up ? "text-positive" : "text-negative", className)}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{up ? "up" : "down"} </span>
      {formatUSD(Math.abs(cents))}
      {label && <span className="text-muted-foreground ml-1 font-normal">{label}</span>}
    </span>
  );
}

/**
 * One metric: small label, the number, and at most one line under it. Put
 * explanations in `help` (a tooltip), not under the number.
 */
export function Stat({ label, value, delta, sub, help, tone = "none", size = "md", className }: {
  label: string;
  value: ReactNode;
  delta?: { cents: number; label?: string };
  sub?: ReactNode;
  help?: ReactNode;
  tone?: "none" | "positive" | "negative" | "info" | "warning";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-muted-foreground flex items-center gap-1 text-[12.5px]">
        <span className="truncate">{label}</span>
        {help && <HelpTip label={`About ${label}`}>{help}</HelpTip>}
      </div>
      <div className={cn(
        "num mt-1 font-semibold tracking-[-0.02em]",
        size === "sm" && "text-base", size === "md" && "text-[22px] leading-7", size === "lg" && "text-[34px] leading-10 tracking-[-0.03em]",
        tone === "positive" && "text-positive", tone === "negative" && "text-negative", tone === "info" && "text-info", tone === "warning" && "text-warning",
      )}>{value}</div>
      {delta && <div className="mt-1"><DeltaText cents={delta.cents} label={delta.label} /></div>}
      {sub != null && <div className="text-muted-foreground mt-1 truncate text-xs">{sub}</div>}
    </div>
  );
}

/**
 * A row of Stats on one surface, split by hairlines instead of separate cards.
 * Columns: 2 on phones, `cols` from lg up. An odd count on phones lets the
 * first (lead) stat span the row, so no cell is left empty.
 */
export function StatGroup({ children, cols = 4, className }: { children: ReactNode; cols?: 2 | 3 | 4 | 5; className?: string }) {
  return (
    <div className={cn(
      "bg-border grid grid-cols-2 gap-px overflow-hidden rounded-xl border max-lg:[&>*:first-child:nth-last-child(odd)]:col-span-2 [&>*]:bg-card [&>*]:px-4 [&>*]:py-3.5 md:[&>*]:px-5 md:[&>*]:py-4",
      cols === 2 && "lg:grid-cols-2", cols === 3 && "lg:grid-cols-3", cols === 4 && "lg:grid-cols-4", cols === 5 && "lg:grid-cols-5",
      className,
    )}>
      {children}
    </div>
  );
}
