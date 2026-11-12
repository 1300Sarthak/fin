/**
 * Pure axis math for the time-series chart. Time is measured in whole UTC days
 * since the epoch ("day numbers"), so a calendar date never shifts with the
 * viewer's time zone and a view window is just two floats.
 */

const MS_DAY = 86_400_000;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const WEEKDAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");

/** "2026-10-24" -> day number. */
export function dayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

/** day number -> "2026-10-24". */
export function isoOf(day: number): string {
  return new Date(Math.round(day) * MS_DAY).toISOString().slice(0, 10);
}

function ymd(day: number) {
  const dt = new Date(Math.round(day) * MS_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), w: dt.getUTCDay() };
}

const dayFromYmd = (y: number, m: number, d = 1) => Math.round(Date.UTC(y, m, d) / MS_DAY);

/** "Thu, Oct 24, 2026" — the tooltip's full date. */
export function longDate(day: number): string {
  const { y, m, d, w } = ymd(day);
  return `${WEEKDAYS[w]}, ${MONTHS[m]} ${d}, ${y}`;
}

/** "Oct 2026" — context for the brush and screen readers. */
export function monthYear(day: number): string {
  const { y, m } = ymd(day);
  return `${MONTHS[m]} ${y}`;
}

export type TickLevel = "year" | "month" | "day";
export type Tick = { day: number; label: string; level: TickLevel };

type Unit =
  | { kind: "day"; step: number }
  | { kind: "week" }
  | { kind: "semimonth" }
  | { kind: "month"; step: number }
  | { kind: "year"; step: number };

/** Finest first. The chart takes the finest one whose labels don't collide. */
const UNITS: Unit[] = [
  { kind: "day", step: 1 },
  { kind: "day", step: 2 },
  { kind: "week" },
  { kind: "semimonth" },
  { kind: "month", step: 1 },
  { kind: "month", step: 2 },
  { kind: "month", step: 3 },
  { kind: "month", step: 6 },
  { kind: "year", step: 1 },
  { kind: "year", step: 2 },
  { kind: "year", step: 5 },
  { kind: "year", step: 10 },
  { kind: "year", step: 25 },
];

const md = (day: number) => {
  const { m, d } = ymd(day);
  return `${m + 1}/${d}`;
};

/** Every calendar boundary of `unit` inside [start, end], labelled. */
function generate(unit: Unit, start: number, end: number): Tick[] {
  const out: Tick[] = [];
  const lo = Math.ceil(start);
  const hi = Math.floor(end);
  const first = ymd(lo);
  const label = (day: number, fine: () => string): Tick => {
    const { y, m, d } = ymd(day);
    if (m === 0 && d === 1) return { day, label: String(y), level: "year" };
    if (unit.kind === "month" && d === 1) return { day, label: MONTHS[m], level: "month" };
    return { day, label: fine(), level: "day" };
  };
  switch (unit.kind) {
    case "day":
      for (let day = lo; day <= hi; day++) if (day % unit.step === 0) out.push(label(day, () => md(day)));
      break;
    case "week":
      // Day 0 (1970-01-01) was a Thursday, so Mondays are day ≡ 4 (mod 7).
      for (let day = lo; day <= hi; day++) if (((day % 7) + 7) % 7 === 4) out.push(label(day, () => md(day)));
      break;
    case "semimonth":
      for (let y = first.y, m = first.m; dayFromYmd(y, m) <= hi; m === 11 ? (y++, (m = 0)) : m++) {
        for (const d of [1, 15]) {
          const day = dayFromYmd(y, m, d);
          if (day >= lo && day <= hi) out.push(label(day, () => md(day)));
        }
      }
      break;
    case "month":
      for (let y = first.y, m = first.m; dayFromYmd(y, m) <= hi; m === 11 ? (y++, (m = 0)) : m++) {
        const day = dayFromYmd(y, m);
        if (day >= lo && m % unit.step === 0) out.push(label(day, () => MONTHS[m]));
      }
      break;
    case "year":
      for (let y = first.y; dayFromYmd(y, 0) <= hi; y++) {
        const day = dayFromYmd(y, 0);
        if (day >= lo && y % unit.step === 0) out.push({ day, label: String(y), level: "year" });
      }
      break;
  }
  return out;
}

/** Jan 1 of every year inside the window: always marked, whatever the zoom. */
function yearStarts(start: number, end: number): Tick[] {
  const out: Tick[] = [];
  for (let y = ymd(Math.ceil(start)).y; dayFromYmd(y, 0) <= end; y++) {
    const day = dayFromYmd(y, 0);
    if (day >= start) out.push({ day, label: String(y), level: "year" });
  }
  return out;
}

/**
 * Pick axis ticks for the window [start, end] (day numbers, may be fractional)
 * drawn `width` pixels wide. Takes the finest calendar unit whose neighbouring
 * labels sit at least `minGap` px apart, so labels never overlap, then pins a
 * year label on every Jan 1 in view and drops ordinary ticks that crowd it.
 * Ticks closer than `edge` px to either side are dropped so labels never clip.
 */
export function timeTicks(start: number, end: number, width: number, opts: { minGap?: number; edge?: number } = {}): Tick[] {
  const minGap = opts.minGap ?? 56;
  const edge = opts.edge ?? 16;
  const span = end - start;
  if (!(span > 0) || !(width > 0)) return [];
  const px = (day: number) => ((day - start) / span) * width;
  const fits = (ticks: Tick[]) => ticks.every((t, i) => i === 0 || px(t.day) - px(ticks[i - 1].day) >= minGap);

  let ticks: Tick[] = [];
  for (const unit of UNITS) {
    // Cheap pre-check before generating thousands of day ticks for a long span.
    const approx = unit.kind === "day" ? unit.step : unit.kind === "week" ? 7 : unit.kind === "semimonth" ? 14 : unit.kind === "month" ? 28 * unit.step : 365 * unit.step;
    if ((approx / span) * width < minGap) continue;
    // Past a quarter, month names read better than a dense run of dates.
    if (span > 92 && (unit.kind === "day" || unit.kind === "week" || unit.kind === "semimonth")) continue;
    const candidate = generate(unit, start, end);
    if (fits(candidate)) {
      ticks = candidate;
      break;
    }
  }

  const years = yearStarts(start, end);
  const merged = [...years, ...ticks.filter((t) => t.level !== "year" && years.every((y) => Math.abs(px(y.day) - px(t.day)) >= minGap))];
  // Years beat everything; if two years collide (absurd zoom-out) keep the first.
  const out: Tick[] = [];
  for (const t of merged.sort((a, b) => a.day - b.day)) {
    const x = px(t.day);
    if (x < edge || x > width - edge) continue;
    const prev = out[out.length - 1];
    if (prev && x - px(prev.day) < minGap) {
      if (t.level === "year" && prev.level !== "year") out[out.length - 1] = t;
      continue;
    }
    out.push(t);
  }
  // A window that opens mid-year says which year on its first month label.
  const first = out[0];
  if (first && first.level === "month") {
    const room = out[1] ? px(out[1].day) - px(first.day) : width;
    if (room >= 80) out[0] = { ...first, label: `${first.label} ${ymd(first.day).y}` };
  }
  return out;
}

/** 1, 2, 2.5, 5 × 10^k ticks covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step || 0); // `|| 0` turns -0 into 0
  return out;
}

/** Y domain for the values in view: padded so the line never kisses an edge, snapped to nice ticks. */
export function yDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    const pad = Math.max(Math.abs(hi) * 0.05, 100);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  return [lo, hi];
}

/** Clamp a [start, end] window inside [min, max] keeping its length (and a minimum length). */
export function clampWindow(start: number, end: number, min: number, max: number, minSpan = 1): [number, number] {
  const full = max - min;
  let span = Math.min(Math.max(end - start, Math.min(minSpan, full)), full);
  if (!(span > 0)) span = Math.max(full, 0);
  let s = start;
  if (s < min) s = min;
  if (s + span > max) s = max - span;
  return [s, s + span];
}

/** Index of the point whose day is nearest `day` in a sorted array (binary search). */
export function nearestIndex(days: number[], day: number): number {
  if (days.length === 0) return -1;
  let lo = 0;
  let hi = days.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (days[mid] <= day) lo = mid;
    else hi = mid;
  }
  return Math.abs(days[hi] - day) < Math.abs(days[lo] - day) ? hi : lo;
}
