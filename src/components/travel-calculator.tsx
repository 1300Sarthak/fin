"use client";

import * as React from "react";
import { Field, inputClass, Money } from "@/components/kit";
import { TravelMark } from "@/components/travel-mark";
import { compareBooking } from "@/lib/travel-compare";
import { DEFAULT_VALUATIONS } from "@/lib/travel-advisor";
import { cn } from "@/lib/utils";

export type CalcDefaults = {
  pointValueHundredthsCpp: number;
  pointsProgram: string;
  portalCard: string;
  portalVia: string;
  portalEarnBp: number;
  directCard: string;
  directCardBp: number;
};
type Hotel = { name: string; hundredthsCpp: number | null };

/**
 * The real decision for a hotel: redeem points in the portal, pay cash in the
 * portal for the portal earn, or book direct for hotel points on the best
 * card. Same arithmetic as `fin points-vs-cash … --hotel NAME`.
 */
export function TravelCalculator({ defaults, hotels, initialHotel }: { defaults: CalcDefaults; hotels: Hotel[]; initialHotel?: string }) {
  const options = React.useMemo(() => [
    ...hotels,
    ...DEFAULT_VALUATIONS.filter((v) => v.kind === "hotel" && !hotels.some((h) => h.name === v.name)).map((v) => ({ name: v.name, hundredthsCpp: v.hundredthsCpp })),
  ], [hotels]);
  const wanted = initialHotel;
  const [hotel, setHotel] = React.useState(() => options.find((o) => o.name === wanted)?.name ?? options.find((o) => /wyndham/i.test(o.name))?.name ?? options[0]?.name ?? "Hotel");
  const [cash, setCash] = React.useState("104");
  const [points, setPoints] = React.useState("9436");
  const [direct, setDirect] = React.useState("");
  const [stays, setStays] = React.useState("1");

  const cashCents = Math.round(Number(cash.replace(/[$,]/g, "")) * 100);
  const pts = Math.round(Number(points.replace(/,/g, "")));
  const directCents = direct.trim() ? Math.round(Number(direct.replace(/[$,]/g, "")) * 100) : undefined;
  const value = options.find((o) => o.name === hotel)?.hundredthsCpp ?? undefined;
  let result: ReturnType<typeof compareBooking> | null = null;
  try {
    if (cashCents > 0 && pts > 0) result = compareBooking({
      cashCents, points: pts, pointValueHundredthsCpp: defaults.pointValueHundredthsCpp, portalEarnBp: defaults.portalEarnBp, portalCard: defaults.portalCard,
      directCashCents: directCents, hotel, hotelValueHundredthsCpp: value, directCard: defaults.directCard, directCardBp: defaults.directCardBp,
      stays: Math.max(1, Math.round(Number(stays) || 1)),
    });
  } catch { result = null; }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-8">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Field label="Hotel program" htmlFor="calc-hotel" className="col-span-2">
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center"><TravelMark name={hotel} size={24} className="rounded-md" /></span>
            <select id="calc-hotel" value={hotel} onChange={(e) => setHotel(e.target.value)} className={cn(inputClass, "pl-10")}>
              {options.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select>
          </div>
        </Field>
        <Field label={`${defaults.portalVia} cash`} htmlFor="calc-cash"><input id="calc-cash" inputMode="decimal" className={cn(inputClass, "num")} value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
        <Field label={`${defaults.portalVia} points`} htmlFor="calc-points"><input id="calc-points" inputMode="numeric" className={cn(inputClass, "num")} value={points} onChange={(e) => setPoints(e.target.value)} /></Field>
        <Field label="Direct price" htmlFor="calc-direct" hint="if different"><input id="calc-direct" inputMode="decimal" placeholder={cash} className={cn(inputClass, "num")} value={direct} onChange={(e) => setDirect(e.target.value)} /></Field>
        <Field label="Stays" htmlFor="calc-stays" help="Wyndham gives at least 1,000 points per stay."><input id="calc-stays" inputMode="numeric" className={cn(inputClass, "num")} value={stays} onChange={(e) => setStays(e.target.value)} /></Field>
        <p className="text-muted-foreground col-span-2 text-xs leading-relaxed">
          {defaults.pointsProgram} at {(defaults.pointValueHundredthsCpp / 100).toFixed(2)}c · {defaults.portalCard} earns {(defaults.portalEarnBp / 100).toFixed(0)}% in {defaults.portalVia} · best direct card {defaults.directCard} at {(defaults.directCardBp / 100).toFixed(1)}%.
        </p>
      </div>

      {result ? (
        <div aria-live="polite">
          <ol className="bg-card divide-y overflow-hidden rounded-xl border">
            {result.options.map((o) => {
              const win = o.key === result.winner.key;
              return (
                <li key={o.key} className={cn("px-4 py-3.5 transition-colors duration-200 md:px-5", win && "bg-positive/5")}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-sm font-medium">
                      {win && <span className="text-positive mr-1.5 text-xs font-semibold">Best</span>}
                      {o.label}
                    </span>
                    <span className="shrink-0 text-right">
                      <Money cents={o.netCents} className={cn("text-[17px] font-semibold", win && "text-positive")} />
                      <span className="text-muted-foreground block text-[11px]">net cost</span>
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{o.lines.map((l, i) => (i === 0 ? l : l.startsWith("−") ? ` ${l}` : ` · ${l}`)).join("")}</p>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-[13px] font-medium">{result.note}</p>
        </div>
      ) : <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-sm">Enter a cash price and a points price to compare.</p>}
    </div>
  );
}
