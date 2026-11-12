import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HelpTip } from "./help-tip";

/** Shared input look: 36px desktop, 44px touch, quiet border, brand focus ring. */
export const inputClass = "border-input bg-background dark:bg-input/20 h-11 w-full rounded-lg border px-3 text-base outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/60 hover:border-foreground/20 focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/20 disabled:opacity-50 sm:h-9 sm:text-sm";

/**
 * Label + control. Help goes in `help` (behind an (i)), not under the field;
 * `hint` is for a few words that must stay visible, like a unit.
 */
export function Field({ label, htmlFor, help, hint, children, className }: {
  label: ReactNode;
  htmlFor: string;
  help?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1.5 flex min-h-5 items-center gap-1">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">{label}</label>
        {help && <HelpTip label={`About ${typeof label === "string" ? label : "this field"}`}>{help}</HelpTip>}
        {hint && <span className="text-muted-foreground ml-auto text-xs">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** A dollar input with a fixed "$" prefix. Value and onChange are whole dollars as the caller stores them. */
export function MoneyInput({ id, value, onChange, max = 100_000_000, className }: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  max?: number;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <span aria-hidden="true" className="text-muted-foreground pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm">$</span>
      <input
        id={id}
        className={cn(inputClass, "num pl-6")}
        type="number"
        inputMode="decimal"
        min="0"
        max={max}
        step="0.01"
        value={value || ""}
        placeholder="0"
        onChange={(event) => { const next = Number(event.target.value); onChange(Number.isFinite(next) ? Math.min(max, Math.max(0, next)) : 0); }}
      />
    </div>
  );
}
