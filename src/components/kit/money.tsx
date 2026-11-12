import { cn } from "@/lib/utils";
import { formatSigned, formatUSD } from "@/lib/format";

/**
 * A dollar amount from integer cents. `dimCents` sets the cents smaller and
 * quieter, for headline figures where the dollars are the point.
 */
export function Money({ cents, signed = false, wholeDollars = false, dimCents = false, tone = "none", className }: {
  cents: number;
  signed?: boolean;
  wholeDollars?: boolean;
  dimCents?: boolean;
  /** "auto" colours by sign; liabilities usually want "negative" explicitly. */
  tone?: "none" | "auto" | "positive" | "negative";
  className?: string;
}) {
  const text = signed ? formatSigned(cents, !wholeDollars) : formatUSD(cents, !wholeDollars);
  const color = tone === "auto" ? (cents < 0 ? "text-negative" : cents > 0 ? "text-positive" : "") : tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "";
  const dot = dimCents && !wholeDollars ? text.lastIndexOf(".") : -1;
  return (
    <span className={cn("num", color, className)}>
      {dot < 0 ? text : <>{text.slice(0, dot)}<span className="text-[0.62em] opacity-50 align-[0.32em] ml-px">{text.slice(dot)}</span></>}
    </span>
  );
}
