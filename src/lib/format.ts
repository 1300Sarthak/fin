import { format, parseISO } from "date-fns";

/** cents -> dollars (number) */
export const toDollars = (cents: number) => cents / 100;
/** dollars -> integer cents (safe rounding) */
export const toCents = (dollars: number) => Math.round(dollars * 100);

const usd = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });

/** "$1,234.56" — pass showCents:false for whole-dollar "$1,235" */
export function formatUSD(cents: number, showCents = true): string {
  return usd(showCents ? 2 : 0, showCents ? 2 : 0).format(toDollars(cents));
}

/** "+$1,234.56" / "-$1,234.56" with the sign in front of the currency symbol */
export function formatSigned(cents: number, showCents = true): string {
  const sign = cents < 0 ? "-" : "+";
  return sign + formatUSD(Math.abs(cents), showCents);
}

/** Compact "$1.2K", "$3.4M" — good for chart axes and tight cards */
export function formatCompact(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(toDollars(cents));
}

export function formatPct(fraction: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction);
}

const asDate = (d: Date | string): Date =>
  typeof d === "string" ? parseISO(d) : d;

/** "Jun 21, 2026" */
export const formatDate = (d: Date | string) => format(asDate(d), "MMM d, yyyy");
/** "Jun 21" */
export const formatDateShort = (d: Date | string) => format(asDate(d), "MMM d");
/** "2026-06" grouping key */
export const monthKey = (d: Date | string) => format(asDate(d), "yyyy-MM");
/** "Jun 2026" label */
export const monthLabel = (d: Date | string) => format(asDate(d), "MMM yyyy");
/** "2026-06-21" calendar date for snapshots */
export const isoDate = (d: Date | string) => format(asDate(d), "yyyy-MM-dd");

/** "1 sheet" / "2 sheets". Pass `plural` when adding an -s is wrong. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}
