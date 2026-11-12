"use client";

import * as React from "react";
import {
  addDays, addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameMonth, parseISO, startOfMonth, startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const iso = (d: Date) => format(d, "yyyy-MM-dd");
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * Click a start day, then an end day; hovering in between previews the range.
 * Arrow keys move by day/week, PageUp/PageDown by month, Home/End to the week's
 * edges, Enter/Space picks. On touch, a horizontal swipe changes month.
 */
export function RangeCalendar({ from, to, onSelect, months = 2, today = iso(new Date()) }: {
  from: string | null;
  to: string | null;
  onSelect: (range: { from: string; to: string }) => void;
  months?: 1 | 2;
  today?: string;
}) {
  const initial = parseISO(to ?? today);
  const [view, setView] = React.useState(() => startOfMonth(months === 2 ? addMonths(initial, -1) : initial));
  const [slide, setSlide] = React.useState<"next" | "prev" | null>(null);
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState(to ?? today);
  const grid = React.useRef<HTMLDivElement>(null);
  const keyboardMove = React.useRef(false);
  const swipe = React.useRef<{ x: number; y: number } | null>(null);

  const shown = Array.from({ length: months }, (_, i) => addMonths(view, i));
  const lastShown = endOfMonth(shown[shown.length - 1]);

  // Preview while choosing the end; otherwise show the applied range.
  const [lo, hi] = anchor
    ? [anchor, hover ?? anchor].sort()
    : [from, to];

  function page(delta: number) {
    setSlide(delta > 0 ? "next" : "prev");
    setView((v) => addMonths(v, delta));
  }

  function pick(day: string) {
    if (!anchor) { setAnchor(day); setHover(day); return; }
    const [a, b] = [anchor, day].sort();
    setAnchor(null);
    setHover(null);
    onSelect({ from: a, to: b });
  }

  function move(day: Date) {
    const next = iso(day);
    keyboardMove.current = true;
    setFocused(next);
    if (anchor) setHover(next);
    if (day < view) page(-1);
    else if (day > lastShown) page(1);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const d = parseISO(focused);
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(d, -1), ArrowRight: () => addDays(d, 1),
      ArrowUp: () => addDays(d, -7), ArrowDown: () => addDays(d, 7),
      Home: () => startOfWeek(d), End: () => endOfWeek(d),
      PageUp: () => addMonths(d, event.shiftKey ? -12 : -1), PageDown: () => addMonths(d, event.shiftKey ? 12 : 1),
    };
    if (moves[event.key]) { event.preventDefault(); move(moves[event.key]()); }
    else if (event.key === "Escape" && anchor) { event.stopPropagation(); setAnchor(null); setHover(null); }
  }

  React.useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus();
  }, [focused, view]);

  // The focusable day must be visible; fall back to the first of the first month.
  const focusable = shown.some((m) => isSameMonth(parseISO(focused), m)) ? focused : iso(view);

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button type="button" onClick={() => page(-1)} aria-label="Previous month" className="hoverable grid size-9 place-items-center rounded-md md:size-8">
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <p className="text-muted-foreground min-w-0 truncate text-center text-xs" aria-live="polite">
          {anchor ? `From ${format(parseISO(anchor), "MMM d, yyyy")} — pick an end date` : "Pick a start date"}
        </p>
        <button type="button" onClick={() => page(1)} aria-label="Next month" className="hoverable grid size-9 place-items-center rounded-md md:size-8">
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div
        ref={grid}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => { if (e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = e.clientX - start.x;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(e.clientY - start.y) * 1.5) page(dx < 0 ? 1 : -1);
        }}
        onPointerLeave={() => { if (anchor) setHover(null); }}
        className={cn("grid touch-pan-y gap-5", months === 2 && "grid-cols-2")}
      >
        {shown.map((month) => (
          <div
            key={iso(month)}
            className={cn(slide === "next" && "cal-slide-next", slide === "prev" && "cal-slide-prev")}
            onAnimationEnd={() => setSlide(null)}
          >
            <p className="mb-1.5 text-center text-[13px] font-medium">{format(month, "MMMM yyyy")}</p>
            <table role="grid" aria-label={format(month, "MMMM yyyy")} className="w-full border-collapse">
              <thead>
                <tr>{WEEKDAYS.map((w) => <th key={w} scope="col" className="text-muted-foreground pb-1 text-center text-[11px] font-normal">{w}</th>)}</tr>
              </thead>
              <tbody>
                {weeks(month).map((week) => (
                  <tr key={iso(week[0])}>
                    {week.map((date) => {
                      const day = iso(date);
                      if (!isSameMonth(date, month)) return <td key={day} />;
                      const edge = day === lo || day === hi;
                      const inside = !!lo && !!hi && day > lo && day < hi;
                      return (
                        <td key={day} className={cn("p-0", inside && "bg-brand/10", day === lo && hi && hi !== lo && "bg-brand/10 rounded-l-md", day === hi && lo && hi !== lo && "bg-brand/10 rounded-r-md")}>
                          <button
                            type="button"
                            data-day={day}
                            tabIndex={day === focusable ? 0 : -1}
                            aria-pressed={edge}
                            aria-label={format(date, "EEEE, MMMM d, yyyy")}
                            aria-current={day === today ? "date" : undefined}
                            onClick={() => pick(day)}
                            onFocus={() => setFocused(day)}
                            onPointerEnter={(e) => { if (anchor && e.pointerType === "mouse") setHover(day); }}
                            className={cn(
                              "num relative grid h-10 w-full place-items-center rounded-md text-[13px] transition-colors duration-100 md:h-8",
                              "focus-visible:outline-2 focus-visible:-outline-offset-2",
                              edge ? "bg-brand font-medium text-white" : "hoverable",
                              day > today && !edge && "text-muted-foreground",
                              day === today && !edge && "font-semibold",
                            )}
                          >
                            {format(date, "d")}
                            {day === today && <span aria-hidden="true" className={cn("absolute bottom-1 size-1 rounded-full", edge ? "bg-white" : "bg-brand")} />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function weeks(month: Date): Date[][] {
  const days = eachDayOfInterval({ start: startOfWeek(startOfMonth(month)), end: endOfWeek(endOfMonth(month)) });
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
}
