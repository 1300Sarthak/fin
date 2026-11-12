import { endOfMonth, format, isValid, parseISO, startOfMonth, startOfYear, subMonths, addDays } from "date-fns";

/**
 * Date-range presets shared by the RangePicker (client) and the pages that read
 * it (server). The URL is the state: `?period=ytd` or
 * `?period=custom&from=2026-01-01&to=2026-03-31`, both bounds inclusive.
 */
export const RANGE_PRESETS = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "ytd", label: "Year to date" },
  { value: "12m", label: "Last 12 months" },
  { value: "all", label: "All time" },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["value"] | "custom";
export type ResolvedRange = {
  preset: RangePreset;
  /** Inclusive YYYY-MM-DD; null means unbounded (all time). */
  from: string | null;
  to: string | null;
  label: string;
};
export type RangeParams = { [key: string]: string | string[] | undefined };

const day = (d: Date) => format(d, "yyyy-MM-dd");
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const validDay = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && isValid(parseISO(v)) ? v : null);

export function presetRange(preset: Exclude<RangePreset, "custom">, today = new Date()): ResolvedRange {
  const label = RANGE_PRESETS.find((p) => p.value === preset)!.label;
  switch (preset) {
    case "this-month": return { preset, from: day(startOfMonth(today)), to: day(today), label };
    case "last-month": { const m = subMonths(today, 1); return { preset, from: day(startOfMonth(m)), to: day(endOfMonth(m)), label }; }
    case "ytd": return { preset, from: day(startOfYear(today)), to: day(today), label };
    case "12m": return { preset, from: day(addDays(subMonths(today, 12), 1)), to: day(today), label };
    case "all": return { preset, from: null, to: null, label };
  }
}

/** A whole calendar year as a custom range; `resolveRange` labels it "2025". */
export function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Reads `period`/`from`/`to` (names prefixable, e.g. "inc" reads incPeriod). Bad input falls back to `fallback`. */
export function resolveRange(params: RangeParams, { prefix = "", fallback = "this-month" as Exclude<RangePreset, "custom">, today = new Date() } = {}): ResolvedRange {
  const key = (k: string) => (prefix ? `${prefix}${k[0].toUpperCase()}${k.slice(1)}` : k);
  const preset = one(params[key("period")]);
  if (preset === "custom") {
    let from = validDay(one(params[key("from")]));
    let to = validDay(one(params[key("to")]));
    if (from && to) {
      if (from > to) [from, to] = [to, from];
      const year = from.slice(0, 4);
      const label = from === `${year}-01-01` && to === `${year}-12-31` ? year : `${format(parseISO(from), "MMM d, yyyy")} – ${format(parseISO(to), "MMM d, yyyy")}`;
      return { preset: "custom", from, to, label };
    }
  }
  const known = RANGE_PRESETS.find((p) => p.value === preset);
  return presetRange(known ? known.value : fallback, today);
}

/** Whether a YYYY-MM-DD (or ISO timestamp) day falls inside the range. */
export function inRange(range: Pick<ResolvedRange, "from" | "to">, isoDay: string): boolean {
  const d = isoDay.slice(0, 10);
  return (!range.from || d >= range.from) && (!range.to || d <= range.to);
}
