"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DeltaText } from "@/components/kit/stat";
import { useReducedMotion } from "@/components/use-reduced-motion";
import { formatCompact, formatDate, formatUSD } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter-core";
import { cn } from "@/lib/utils";
import { clampWindow, dayOf, isoOf, longDate, monthYear, nearestIndex, niceTicks, timeTicks, yDomain } from "./time-axis";

/**
 * A zoomable net-worth line. Drag or swipe to pan, pinch / ctrl+wheel to zoom,
 * drag the strip underneath to move the window. The axis re-picks its ticks on
 * every frame (years → months → 10/24-style days) so labels never collide.
 *
 * Drawn as plain SVG in pixel space: ~1k points re-pathed per frame is far
 * under a millisecond, and keeps the fill, strokes and labels crisp at any zoom.
 */

export type SeriesPoint = {
  date: string;
  cents: number;
  /** "manual" = a hand-recorded checkpoint; "estimated" = reconstructed history. */
  kind: "manual" | "estimated" | "actual";
  manualCents?: number;
};

type Win = [number, number];

const PLOT_H = 240;
const BRUSH_H = 40;
const PAD_TOP = 12;
const AXIS_H = 26;
const Y_GUTTER = 48;
const DURATION = 280;
const DRAG_SLOP = 4;
const MIN_SPAN = 1; // days
const PAD_X = 6; // so end points and dots never sit on the clip edge

/** cubic-bezier(0.22, 1, 0.36, 1) — the app's --ease-out token, solved for x. */
function easeOut(t: number): number {
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const bez = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/** Keep receiving moves outside the element; a pointer the browser no longer tracks just skips it. */
function capture(ev: React.PointerEvent<HTMLElement>) {
  try {
    ev.currentTarget.setPointerCapture(ev.pointerId);
  } catch {}
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function TimeSeriesChart({
  points,
  realFrom,
  window: windowProp,
  label = "Net worth over time",
  drill = true,
  className,
}: {
  points: SeriesPoint[];
  /** First snapshot-backed day; reconstructed days before it are shaded. */
  realFrom?: string | null;
  /** Visible window, inclusive YYYY-MM-DD; null ends = the data's extent. */
  window: { from: string | null; to: string | null };
  label?: string;
  /** Click a day to open its transactions. */
  drill?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const still = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const plotW = Math.max(0, width - Y_GUTTER);

  const data = useMemo(() => {
    const days = points.map((p) => dayOf(p.date));
    const values = points.map((p) => p.cents);
    const lo = days[0] ?? 0;
    const hi = days[days.length - 1] ?? 1;
    // A single point still needs a span to sit in.
    const extent: Win = lo === hi ? [lo - 1, hi + 1] : [lo, hi];
    const firstSeries = points.findIndex((p) => p.kind !== "manual");
    return { days, values, extent, firstSeries };
  }, [points]);

  const target = useMemo<Win>(() => {
    const [min, max] = data.extent;
    const from = windowProp.from ? Math.max(min, dayOf(windowProp.from)) : min;
    const to = windowProp.to ? Math.min(max, dayOf(windowProp.to)) : max;
    return clampWindow(from, to > from ? to : max, min, max, MIN_SPAN);
  }, [windowProp.from, windowProp.to, data.extent]);

  const yTargetFor = useCallback(
    ([s, e]: Win): Win => {
      const { days, values } = data;
      const vis: number[] = [];
      for (let i = 0; i < days.length; i++) {
        // One neighbour either side, so the line leaving the frame stays in frame.
        if (days[i] >= s && days[i] <= e) vis.push(values[i]);
        else if ((days[i + 1] ?? Infinity) >= s && days[i] < s) vis.push(values[i]);
        else if ((days[i - 1] ?? -Infinity) <= e && days[i] > e) vis.push(values[i]);
      }
      return yDomain(vis.length ? vis : values);
    },
    [data],
  );

  // Rendered state. Gestures and tweens write the refs and request a frame.
  const [view, setView] = useState<Win>(target);
  const [yDom, setYDom] = useState<Win>(() => yTargetFor(target));
  const viewRef = useRef(view);
  const yRef = useRef(yDom);
  const tween = useRef<{ from: Win; to: Win; yFrom: Win; yTo: Win; t0: number } | null>(null);
  const raf = useRef(0);
  const lastFrame = useRef(0);
  const frameRef = useRef<(now: number) => void>(() => {});

  const frame = useCallback(
    (now: number) => {
      raf.current = 0;
      const dt = Math.min(64, now - (lastFrame.current || now));
      lastFrame.current = now;
      let more = false;
      const tw = tween.current;
      if (tw) {
        const p = Math.min(1, (now - tw.t0) / DURATION);
        const k = easeOut(p);
        viewRef.current = [tw.from[0] + (tw.to[0] - tw.from[0]) * k, tw.from[1] + (tw.to[1] - tw.from[1]) * k];
        yRef.current = [tw.yFrom[0] + (tw.yTo[0] - tw.yFrom[0]) * k, tw.yFrom[1] + (tw.yTo[1] - tw.yFrom[1]) * k];
        if (p < 1) more = true;
        else tween.current = null;
      } else {
        // While panning, the y scale chases the visible values instead of snapping.
        const goal = yTargetFor(viewRef.current);
        const a = still ? 1 : 1 - Math.exp(-dt / 90);
        const [y0, y1] = yRef.current;
        const next: Win = [y0 + (goal[0] - y0) * a, y1 + (goal[1] - y1) * a];
        const settled = Math.abs(next[0] - goal[0]) + Math.abs(next[1] - goal[1]) < (goal[1] - goal[0]) * 0.002;
        yRef.current = settled ? goal : next;
        if (!settled) more = true;
      }
      setView(viewRef.current);
      setYDom(yRef.current);
      if (more) raf.current = requestAnimationFrame((t) => frameRef.current(t));
      else lastFrame.current = 0;
    },
    [still, yTargetFor],
  );
  useLayoutEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  const kick = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame((t) => frameRef.current(t));
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const setWindow = useCallback(
    (w: Win, animate: boolean) => {
      const [min, max] = data.extent;
      const next = clampWindow(w[0], w[1], min, max, MIN_SPAN);
      if (animate && !still) {
        tween.current = { from: viewRef.current, to: next, yFrom: yRef.current, yTo: yTargetFor(next), t0: performance.now() };
      } else {
        tween.current = null;
        viewRef.current = next;
        if (still) yRef.current = yTargetFor(next);
      }
      kick();
    },
    [data.extent, kick, still, yTargetFor],
  );

  // A new range from the page (range buttons, picker) glides the window there.
  const lastTarget = useRef(target);
  useEffect(() => {
    if (lastTarget.current[0] === target[0] && lastTarget.current[1] === target[1]) return;
    lastTarget.current = target;
    setWindow(target, true);
  }, [target, setWindow]);

  /* ------------------------------- scales -------------------------------- */
  const [s, e] = view;
  const span = e - s || 1;
  const [ylo, yhi] = yDom;
  const plotH = PLOT_H - PAD_TOP - AXIS_H;
  const innerW = Math.max(1, plotW - 2 * PAD_X);
  const xOf = useCallback((day: number) => PAD_X + ((day - s) / span) * innerW, [s, span, innerW]);
  const yOf = (v: number) => PAD_TOP + (1 - (v - ylo) / (yhi - ylo || 1)) * plotH;
  const dayAt = (px: number) => s + ((px - PAD_X) / innerW) * span;

  const { days, values } = data;
  const firstSeries = data.firstSeries;

  // Only the points in view (plus a neighbour) are pathed.
  let i0 = 0;
  let i1 = days.length - 1;
  while (i0 < days.length - 1 && days[i0 + 1] < s) i0++;
  while (i1 > 0 && days[i1 - 1] > e) i1--;
  const pathOf = (from: number, to: number) => {
    let d = "";
    for (let i = Math.max(from, i0); i <= Math.min(to, i1); i++) d += `${d ? "L" : "M"}${xOf(days[i]).toFixed(1)},${yOf(values[i]).toFixed(1)}`;
    return d;
  };
  const manualEnd = firstSeries === -1 ? days.length - 1 : firstSeries; // dashed run includes the hand-off point
  const manualPath = firstSeries === 0 ? "" : pathOf(0, manualEnd);
  const seriesPath = firstSeries === -1 ? "" : pathOf(firstSeries, days.length - 1);
  const linePath = pathOf(0, days.length - 1);
  const baseY = PAD_TOP + plotH;
  const areaPath = linePath ? `${linePath}L${xOf(days[Math.min(i1, days.length - 1)]).toFixed(1)},${baseY}L${xOf(days[i0]).toFixed(1)},${baseY}Z` : "";

  // Ticks are picked in inner-plot coordinates, then offset by PAD_X when drawn.
  const xTicks = useMemo(() => timeTicks(s, e, innerW, { edge: 0 }), [s, e, innerW]);
  const yTicks = niceTicks(ylo, yhi, 4).filter((v) => yOf(v) >= PAD_TOP - 1 && yOf(v) <= baseY + 1);

  const realDay = realFrom ? dayOf(realFrom) : null;
  const seriesDay = firstSeries >= 0 ? days[firstSeries] : null;
  const estFrom = seriesDay;
  const estTo = seriesDay === null ? null : realDay ?? days[days.length - 1];
  const showEst = estFrom !== null && estTo !== null && estTo > estFrom && points.some((p) => p.kind === "estimated");

  /* ------------------------------- hover --------------------------------- */
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false); // touch: tooltip stays after the tap
  const hovered = hover !== null && hover >= 0 && hover < points.length ? hover : null;
  const point = hovered !== null ? points[hovered] : null;
  const prev = hovered !== null && hovered > 0 ? points[hovered - 1] : null;
  const canDrill = (p: SeriesPoint | null) => drill && !!p && p.kind !== "manual";
  const open = (p: SeriesPoint) => router.push(txnHref({ from: p.date, to: p.date }));

  /* ------------------------------ gestures ------------------------------- */
  const plotRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; type: string }>());
  const gesture = useRef<
    | { kind: "pan"; x0: number; view0: Win; moved: boolean; type: string }
    | { kind: "pinch"; d0: number; anchor: number; view0: Win }
    | null
  >(null);

  const localX = (clientX: number) => clientX - (plotRef.current?.getBoundingClientRect().left ?? 0);

  function onPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    pointers.current.set(ev.pointerId, { x: localX(ev.clientX), type: ev.pointerType });
    capture(ev);
    tween.current = null;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", d0: Math.max(8, Math.abs(a.x - b.x)), anchor: dayAt((a.x + b.x) / 2), view0: viewRef.current };
      setHover(null);
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: "pan", x0: localX(ev.clientX), view0: viewRef.current, moved: false, type: ev.pointerType };
    }
  }

  function onPointerMove(ev: React.PointerEvent<HTMLDivElement>) {
    const x = localX(ev.clientX);
    if (pointers.current.has(ev.pointerId)) pointers.current.set(ev.pointerId, { x, type: ev.pointerType });
    const g = gesture.current;
    if (g?.kind === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.max(8, Math.abs(a.x - b.x));
      const mid = (a.x + b.x) / 2;
      const nextSpan = ((g.view0[1] - g.view0[0]) * g.d0) / d;
      const start = g.anchor - ((mid - PAD_X) / innerW) * nextSpan;
      setWindow([start, start + nextSpan], false);
      return;
    }
    if (g?.kind === "pan") {
      const dx = x - g.x0;
      if (!g.moved && Math.abs(dx) > DRAG_SLOP) {
        g.moved = true;
        setHover(null);
        setPinned(false);
      }
      if (g.moved) {
        const shift = (-dx / innerW) * (g.view0[1] - g.view0[0]);
        setWindow([g.view0[0] + shift, g.view0[1] + shift], false);
        return;
      }
    }
    if (ev.pointerType === "mouse" && !g) setHover(nearestIndex(days, dayAt(x)));
  }

  function onPointerUp(ev: React.PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    pointers.current.delete(ev.pointerId);
    if (g?.kind === "pinch") {
      // Lifting one finger of a pinch must not turn into a pan jump.
      gesture.current = null;
      pointers.current.clear();
      return;
    }
    gesture.current = null;
    if (g?.kind !== "pan" || g.moved || ev.type === "pointercancel") return;
    const idx = nearestIndex(days, dayAt(localX(ev.clientX)));
    if (idx < 0) return;
    if (g.type === "mouse") {
      if (canDrill(points[idx])) open(points[idx]);
    } else {
      setHover(idx);
      setPinned(true);
    }
  }

  // Wheel needs a non-passive listener to keep ctrl+wheel from zooming the page.
  const wheelRef = useRef<(ev: WheelEvent) => void>(() => {});
  const onWheel = (ev: WheelEvent) => {
    const x = localX(ev.clientX);
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const factor = Math.exp(ev.deltaY * 0.01);
      const anchor = dayAt(x);
      const nextSpan = Math.min(data.extent[1] - data.extent[0], Math.max(MIN_SPAN, span * factor));
      const start = anchor - ((x - PAD_X) / innerW) * nextSpan;
      setWindow([start, start + nextSpan], false);
    } else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey) {
      ev.preventDefault();
      const dx = ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX;
      const shift = (dx / innerW) * span;
      setWindow([s + shift, e + shift], false);
    }
    // Plain vertical scrolling is left to the page.
  };
  useLayoutEffect(() => {
    wheelRef.current = onWheel;
  });
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const fn = (ev: WheelEvent) => wheelRef.current(ev);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [width]);

  // Tapping anywhere else dismisses a pinned (touch) tooltip.
  useEffect(() => {
    if (!pinned) return;
    const off = (ev: PointerEvent) => {
      if (!plotRef.current?.parentElement?.contains(ev.target as Node)) {
        setPinned(false);
        setHover(null);
      }
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [pinned]);

  function onKeyDown(ev: React.KeyboardEvent<HTMLDivElement>) {
    // Keyboard moves are instant: no tweening on high-frequency input.
    const last = nearestIndex(days, e);
    const cur = hovered ?? last;
    let next: number | null = null;
    if (ev.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (ev.key === "ArrowRight") next = Math.min(days.length - 1, cur + 1);
    else if (ev.key === "Home") next = nearestIndex(days, s);
    else if (ev.key === "End") next = last;
    else if ((ev.key === "+" || ev.key === "=") && span > MIN_SPAN) {
      const mid = (s + e) / 2;
      setWindow([mid - span / 4, mid + span / 4], false);
    } else if (ev.key === "-") {
      const mid = (s + e) / 2;
      setWindow([mid - span, mid + span], false);
    } else if (ev.key === "Enter" && point && canDrill(point)) open(point);
    else if (ev.key === "Escape") setHover(null);
    else return;
    ev.preventDefault();
    if (next !== null) {
      setHover(next);
      if (days[next] < s || days[next] > e) setWindow([days[next] - span / 2, days[next] + span / 2], false);
    }
  }

  /* ------------------------------- brush --------------------------------- */
  const brushRef = useRef<HTMLDivElement>(null);
  const [bMin, bMax] = data.extent;
  const bSpan = bMax - bMin || 1;
  const bx = (day: number) => ((day - bMin) / bSpan) * plotW;
  const brushPath = useMemo(() => {
    if (!plotW || days.length === 0) return { line: "", area: "" };
    const [lo, hi] = yDomain(values);
    const by = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (BRUSH_H - 8);
    const sx = (day: number) => ((day - bMin) / bSpan) * plotW;
    const line = days.map((d, i) => `${i ? "L" : "M"}${sx(d).toFixed(1)},${by(values[i]).toFixed(1)}`).join("");
    return { line, area: `${line}L${sx(days[days.length - 1]).toFixed(1)},${BRUSH_H}L${sx(days[0]).toFixed(1)},${BRUSH_H}Z` };
  }, [days, values, plotW, bMin, bSpan]);
  const brushTicks = useMemo(() => timeTicks(bMin, bMax, plotW, { minGap: 44, edge: 12 }).filter((t) => t.level !== "day"), [bMin, bMax, plotW]);
  const brushGesture = useRef<{ mode: "move" | "l" | "r"; x0: number; view0: Win } | null>(null);

  function onBrushDown(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const x = ev.clientX - (brushRef.current?.getBoundingClientRect().left ?? 0);
    const l = bx(s);
    const r = bx(e);
    const grab = ev.pointerType === "mouse" ? 8 : 18;
    capture(ev);
    tween.current = null;
    if (Math.abs(x - l) <= grab && x < (l + r) / 2) brushGesture.current = { mode: "l", x0: x, view0: viewRef.current };
    else if (Math.abs(x - r) <= grab) brushGesture.current = { mode: "r", x0: x, view0: viewRef.current };
    else if (x > l && x < r) brushGesture.current = { mode: "move", x0: x, view0: viewRef.current };
    else {
      // Outside the window: glide it to centre on the tapped day.
      const day = bMin + (x / (plotW || 1)) * bSpan;
      setWindow([day - span / 2, day + span / 2], true);
      brushGesture.current = { mode: "move", x0: x, view0: [day - span / 2, day + span / 2] };
    }
  }
  function onBrushMove(ev: React.PointerEvent<HTMLDivElement>) {
    const g = brushGesture.current;
    if (!g) return;
    const x = ev.clientX - (brushRef.current?.getBoundingClientRect().left ?? 0);
    const dDay = ((x - g.x0) / (plotW || 1)) * bSpan;
    const [v0, v1] = g.view0;
    if (g.mode === "move") setWindow([v0 + dDay, v1 + dDay], false);
    else if (g.mode === "l") setWindow([Math.min(v0 + dDay, v1 - MIN_SPAN), v1], false);
    else setWindow([v0, Math.max(v1 + dDay, v0 + MIN_SPAN)], false);
  }
  const onBrushUp = () => {
    brushGesture.current = null;
  };

  const zoomed = Math.abs(view[0] - target[0]) > 0.05 || Math.abs(view[1] - target[1]) > 0.05;
  const hasManual = firstSeries !== 0 && points.length > 0;

  /* ------------------------------- render -------------------------------- */
  const hx = point ? xOf(days[hovered!]) : 0;
  const hy = point ? yOf(point.cents) : 0;
  const tipW = 220;
  const tipX = Math.min(Math.max(hx - tipW / 2, 0), Math.max(0, width - tipW));
  const tipBelow = hy < 110;

  return (
    <div className={cn("relative select-none", className)} ref={boxRef}>
      <div
        ref={plotRef}
        role="group"
        aria-label={`${label}. Drag to pan, pinch or ctrl+scroll to zoom, arrow keys to step through days.`}
        tabIndex={0}
        className="relative cursor-crosshair touch-pan-y rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        style={{ height: PLOT_H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(ev) => {
          if (ev.pointerType === "mouse" && !gesture.current) setHover(null);
        }}
        onKeyDown={onKeyDown}
      >
        {width > 0 && (
          <svg width={width} height={PLOT_H} className="block overflow-visible" aria-hidden="true">
            <defs>
              <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.24} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
              <clipPath id={`${uid}-clip`}>
                <rect x={0} y={0} width={plotW} height={PLOT_H} />
              </clipPath>
            </defs>

            {/* horizontal grid + y labels on the right */}
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={0} x2={plotW} y1={yOf(v)} y2={yOf(v)} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={width - 2} y={yOf(v)} dy="0.35em" textAnchor="end" className="num fill-muted-foreground text-[11px]">
                  {formatCompact(v)}
                </text>
              </g>
            ))}

            <g clipPath={`url(#${uid}-clip)`}>
              {showEst && (
                <g>
                  <rect x={xOf(estFrom!)} y={PAD_TOP} width={Math.max(0, xOf(estTo!) - xOf(estFrom!))} height={plotH} fill="var(--muted-foreground)" fillOpacity={0.07} />
                  {xOf(estTo!) - Math.max(0, xOf(estFrom!)) > 72 && (
                    <text x={Math.max(0, xOf(estFrom!)) + 8} y={PAD_TOP + 14} className="fill-muted-foreground text-[11px]">Estimated</text>
                  )}
                </g>
              )}
              {hasManual && seriesDay !== null && xOf(seriesDay) > 110 && (
                <text x={Math.max(8, xOf(days[0]) + 8)} y={PAD_TOP + 14} className="fill-muted-foreground text-[11px]">Recorded by hand</text>
              )}
              {/* year boundaries */}
              {xTicks.filter((t) => t.level === "year").map((t) => (
                <line key={`yr${t.day}`} x1={xOf(t.day)} x2={xOf(t.day)} y1={PAD_TOP} y2={baseY} stroke="var(--border)" strokeDasharray="2 3" />
              ))}
              <path d={areaPath} fill={`url(#${uid}-fill)`} />
              {manualPath && <path d={manualPath} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />}
              {seriesPath && <path d={seriesPath} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {/* hand-recorded checkpoints as dots */}
              {points.map((p, i) =>
                p.kind === "manual" || p.manualCents !== undefined ? (
                  <circle key={p.date} cx={xOf(days[i])} cy={yOf(p.manualCents ?? p.cents)} r={3} fill="var(--card)" stroke="var(--chart-1)" strokeWidth={1.5} />
                ) : null,
              )}
              {/* crosshair */}
              {point && (
                <g>
                  <line x1={hx} x2={hx} y1={PAD_TOP} y2={baseY} stroke="var(--muted-foreground)" strokeOpacity={0.5} strokeWidth={1} shapeRendering="crispEdges" />
                  <circle cx={hx} cy={hy} r={4.5} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={2} />
                </g>
              )}
            </g>

            {/* x axis */}
            <line x1={0} x2={plotW} y1={baseY} y2={baseY} stroke="var(--border)" shapeRendering="crispEdges" />
            {xTicks.map((t) => (
              <text
                key={`${t.level}${t.day}`}
                x={xOf(t.day)}
                y={baseY + 17}
                // Edge labels hug the frame instead of being cut in half.
                textAnchor={xOf(t.day) < 24 ? "start" : xOf(t.day) > plotW - 24 ? "end" : "middle"}
                className={cn("num text-[11px]", t.level === "year" ? "fill-foreground font-semibold" : "fill-muted-foreground")}
              >
                {t.label}
              </text>
            ))}
          </svg>
        )}

        {zoomed && (
          <button
            type="button"
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={() => setWindow(target, true)}
            className="bg-card/90 text-muted-foreground hover:text-foreground pressable absolute top-1 rounded-md border px-2 py-1 text-xs backdrop-blur"
            style={{ right: Y_GUTTER + 4 }}
          >
            Reset zoom
          </button>
        )}

        {point && (
          <div
            role="status"
            data-chart-tooltip=""
            className={cn(
              "bg-popover text-popover-foreground pointer-events-none absolute top-0 left-0 z-10 rounded-lg border px-3 py-2 shadow-[var(--shadow-pop)]",
              pinned && "pointer-events-auto",
            )}
            style={{ width: tipW, transform: `translate3d(${tipX}px, ${tipBelow ? hy + 14 : Math.max(0, hy - 104)}px, 0)` }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium">{longDate(days[hovered!])}</span>
              {point.kind !== "actual" && (
                <span className={cn("rounded-full px-1.5 py-px text-[10.5px]", point.kind === "estimated" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>
                  {point.kind === "estimated" ? "Estimated" : "Manual"}
                </span>
              )}
            </div>
            <div className="num mt-0.5 text-[16px] font-semibold tracking-[-0.01em]">{formatUSD(point.cents)}</div>
            {prev && (
              <DeltaText
                className="text-[12px]"
                cents={point.cents - prev.cents}
                label={dayOf(point.date) - dayOf(prev.date) === 1 ? "day change" : `since ${formatDate(prev.date)}`}
              />
            )}
            {point.manualCents !== undefined && (
              <div className="text-muted-foreground mt-0.5 text-[11.5px]">Recorded by hand: <span className="num">{formatUSD(point.manualCents)}</span></div>
            )}
            {canDrill(point) &&
              (pinned ? (
                <Link href={txnHref({ from: point.date, to: point.date })} className="text-brand mt-1.5 -mb-1 flex min-h-11 items-center text-[13px] font-medium">
                  View transactions →
                </Link>
              ) : (
                <div className="text-muted-foreground mt-1 text-[11px]">Click for this day&apos;s transactions</div>
              ))}
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {point ? `${longDate(days[hovered!])}: ${formatUSD(point.cents)}${point.kind === "estimated" ? ", estimated" : point.kind === "manual" ? ", recorded by hand" : ""}` : ""}
        </span>
      </div>

      {/* overview strip: the whole history, with the visible window */}
      {width > 0 && days.length > 1 && (
        <div
          ref={brushRef}
          className="relative mt-2 cursor-grab touch-pan-y active:cursor-grabbing"
          style={{ width: plotW, height: BRUSH_H + 16 }}
          onPointerDown={onBrushDown}
          onPointerMove={onBrushMove}
          onPointerUp={onBrushUp}
          onPointerCancel={onBrushUp}
          aria-label={`Visible window: ${monthYear(s)} to ${monthYear(e)}`}
          role="img"
        >
          <svg width={plotW} height={BRUSH_H + 16} className="block" aria-hidden="true">
            <path d={brushPath.area} fill="var(--muted-foreground)" fillOpacity={0.1} />
            <path d={brushPath.line} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeWidth={1} />
            {brushTicks.map((t) => (
              <text key={t.day} x={bx(t.day)} y={BRUSH_H + 13} textAnchor="middle" className={cn("text-[10px]", t.level === "year" ? "fill-foreground font-medium" : "fill-muted-foreground")}>
                {t.label}
              </text>
            ))}
            {/* dim outside the window */}
            <rect x={0} y={0} width={Math.max(0, bx(s))} height={BRUSH_H} fill="var(--background)" fillOpacity={0.55} />
            <rect x={bx(e)} y={0} width={Math.max(0, plotW - bx(e))} height={BRUSH_H} fill="var(--background)" fillOpacity={0.55} />
            <rect x={bx(s)} y={0.5} width={Math.max(2, bx(e) - bx(s))} height={BRUSH_H - 1} rx={4} fill="var(--chart-1)" fillOpacity={0.08} stroke="var(--chart-1)" strokeOpacity={0.55} />
            {[bx(s), bx(e)].map((hx2, i) => (
              <rect key={i} x={hx2 - 2} y={BRUSH_H / 2 - 8} width={4} height={16} rx={2} fill="var(--chart-1)" />
            ))}
          </svg>
        </div>
      )}

      {(hasManual || showEst) && (
        <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
          {seriesDay !== null && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden="true"><line x1="0" x2="16" y1="3" y2="3" stroke="var(--chart-1)" strokeWidth="2" /></svg>
              Synced{realFrom ? ` (daily snapshots from ${formatDate(realFrom)})` : ""}
            </span>
          )}
          {hasManual && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden="true"><line x1="0" x2="16" y1="3" y2="3" stroke="var(--chart-1)" strokeWidth="2" strokeDasharray="4 3" /></svg>
              Recorded by hand{seriesDay !== null ? ` (before ${formatDate(isoOf(seriesDay))})` : ""}
            </span>
          )}
          {showEst && (
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-muted-foreground/15 inline-block h-2.5 w-3.5 rounded-sm" aria-hidden="true" />
              Estimated from transactions
            </span>
          )}
        </div>
      )}
    </div>
  );
}
