import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatUSD } from "@/lib/format";

/** A signed change chip: green up / red down, with an optional period label. */
export function Delta({
  cents,
  label,
  className,
}: {
  cents: number;
  label?: string;
  className?: string;
}) {
  const up = cents >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-sm font-medium tabular-nums",
        up ? "text-positive" : "text-negative",
        className,
      )}
    >
      <Icon className="size-3.5" />
      {formatUSD(Math.abs(cents))}
      {label && (
        <span className="text-muted-foreground ml-1 font-normal">{label}</span>
      )}
    </span>
  );
}
