export type BackfillWindow = { start: string; end: string };

const MS_DAY = 86_400_000;
const toDay = (iso: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) throw new Error(`expected a date like 2025-01-31, got "${iso}"`);
  return Date.parse(`${iso}T00:00:00Z`) / MS_DAY;
};
const toIso = (day: number) => new Date(day * MS_DAY).toISOString().slice(0, 10);

/**
 * Inclusive day windows covering [since, until], newest first, each at most
 * `windowDays` long (SimpleFIN warns above 45 days and may cap the response).
 * Newest first so a walk that stops early has filled the most recent gap.
 */
export function planBackfillWindows(since: string, until: string, windowDays = 45): BackfillWindow[] {
  const lo = toDay(since);
  const hi = toDay(until);
  if (!(windowDays >= 1)) throw new Error("window must be at least one day");
  if (lo > hi) return [];
  const out: BackfillWindow[] = [];
  for (let end = hi; end >= lo; end -= windowDays) {
    out.push({ start: toIso(Math.max(lo, end - windowDays + 1)), end: toIso(end) });
  }
  return out;
}
