import { brandFor } from "@/lib/travel-brands";
import { cn } from "@/lib/utils";

/**
 * A program's brand tile: its colours and monogram, drawn locally as SVG so
 * nothing is fetched at runtime and it stays crisp at any size.
 */
export function TravelMark({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  const b = brandFor(name);
  const long = b.mark.length > 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      role="img"
      aria-label={`${name} logo`}
      className={cn("shrink-0 rounded-[10px] ring-1 ring-foreground/10", className)}
    >
      <rect width="36" height="36" rx="10" fill={b.bg} />
      <text
        x="18"
        y="18"
        textAnchor="middle"
        dominantBaseline="central"
        fill={b.fg}
        fontSize={long ? 10.5 : b.mark.length === 2 ? 13 : 17}
        fontWeight={700}
        letterSpacing={long ? -0.2 : -0.4}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {b.mark}
      </text>
    </svg>
  );
}
