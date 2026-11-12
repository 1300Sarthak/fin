"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { TimeSeriesChart, type SeriesPoint } from "@/components/kit/time-series-chart";
import { dayOf, isoOf } from "@/components/kit/time-axis";

/**
 * The Overview range, shared by the range buttons and the chart so a click
 * moves the chart (and the selected pill) at once, while the server work for
 * the figures that depend on the range catches up behind it.
 */
type Ctx = { value: string; set: (v: string) => void };
const RangeCtx = createContext<Ctx | null>(null);

export function NetWorthRangeProvider({ value, children }: { value: string; children: ReactNode }) {
  const [picked, setPicked] = useState<{ value: string; from: string } | null>(null);
  // A pick lives until the server's value moves; then the URL is the truth again.
  const current = picked && picked.from === value ? picked.value : value;
  return <RangeCtx.Provider value={{ value: current, set: (v) => setPicked({ value: v, from: value }) }}>{children}</RangeCtx.Provider>;
}

export const useNetWorthRange = () => useContext(RangeCtx);

/** Mirrors the range lengths in lib/networth (1D draws yesterday and today). */
const WINDOW_DAYS: Record<string, number> = { "1D": 2, "1W": 7, "1M": 30, "3M": 90, "6M": 182, "1Y": 365 };

export function NetWorthRangeChart({ points, realFrom, today }: { points: SeriesPoint[]; realFrom: string | null; today: string }) {
  const range = useNetWorthRange()?.value ?? "1M";
  const days = WINDOW_DAYS[range];
  const from = range === "MAX" || !days ? null : isoOf(dayOf(today) - days + 1);
  return <TimeSeriesChart points={points} realFrom={realFrom} window={{ from, to: null }} />;
}
