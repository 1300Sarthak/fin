"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BedDouble, Car, Plane, Plus, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Field, inputClass, Money, Segmented, ResponsiveSheet } from "@/components/kit";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type TripRow = {
  id: number; kind: string; title: string; provider: string; startDate: string; endDate: string | null;
  costCents: number | null; pointsUsed: number | null; bookedVia: string | null; source: string; program: string | null;
};

const ICON = { flight: Plane, hotel: BedDouble, car: Car, other: Ticket } as const;
const KINDS = ["hotel", "flight", "car", "other"] as const;

function nights(a: string, b: string | null) {
  return b ? Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)) : 0;
}

function Timeline({ trips, empty }: { trips: TripRow[]; empty: string }) {
  if (!trips.length) return <p className="text-muted-foreground px-5 py-6 text-sm">{empty}</p>;
  return (
    <ol className="divide-y">
      {trips.map((t) => {
        const Icon = ICON[t.kind as keyof typeof ICON] ?? Ticket;
        const n = t.kind === "hotel" ? nights(t.startDate, t.endDate) : 0;
        return (
          <li key={t.id} className="flex items-center gap-3 px-4 py-3 md:px-5">
            <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg"><Icon className="size-4" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.title}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {[formatDate(t.startDate) + (t.endDate && t.endDate !== t.startDate ? ` – ${formatDate(t.endDate)}` : ""), n > 0 && `${n} night${n === 1 ? "" : "s"}`, t.program ?? t.provider, t.bookedVia && `via ${t.bookedVia}`, t.source === "gmail" && "from Gmail"].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="num shrink-0 text-right text-sm">
              {t.costCents != null ? <Money cents={t.costCents} /> : t.pointsUsed ? null : <span className="text-muted-foreground">—</span>}
              {t.pointsUsed ? <span className="text-muted-foreground block text-xs">{t.pointsUsed.toLocaleString("en-US")} pts</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Upcoming and past bookings, and a small form to add one (same write as `fin trips add`). */
export function TravelTrips({ upcoming, past, programs, rangeLabel }: { upcoming: TripRow[]; past: TripRow[]; programs: { id: number; name: string }[]; rangeLabel: string }) {
  const router = useRouter();
  const [view, setView] = React.useState<"upcoming" | "past">(upcoming.length ? "upcoming" : "past");
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const blank = { kind: "hotel", provider: "", title: "", start: "", end: "", cost: "", programId: "", via: "" };
  const [d, setD] = React.useState(blank);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const cost = d.cost.trim() ? Math.round(Number(d.cost.replace(/[$,]/g, "")) * 100) : null;
    if (cost != null && !(cost >= 0)) return toast.error("Cost must be a dollar amount");
    setBusy(true);
    try {
      const res = await fetch("/api/travel/trips", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: d.kind, provider: d.provider, title: d.title, startDate: d.start, endDate: d.end || null, costCents: cost, programId: d.programId ? Number(d.programId) : null, bookedVia: d.via || null, source: "manual" }),
      });
      const data = (await res.json()) as { ok: boolean; created?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save");
      toast.success(data.created ? "Trip added" : "Trip updated");
      setAdding(false);
      setD(blank);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });

  return (
    <section className="scroll-mt-28">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Trips</h2>
          <p className="text-muted-foreground mt-0.5 text-[13px]">{view === "upcoming" ? `${upcoming.length} booked` : `${past.length} · ${rangeLabel}`}</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented aria-label="Trips" options={[{ value: "upcoming", label: `Upcoming${upcoming.length ? ` ${upcoming.length}` : ""}` }, { value: "past", label: "Past" }]} value={view} onValueChange={setView} />
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="size-4" />Add trip</Button>
        </div>
      </div>
      <div className="bg-card overflow-hidden rounded-xl border">
        {view === "upcoming"
          ? <Timeline trips={upcoming} empty="No upcoming bookings. Add one, or import from Gmail." />
          : <Timeline trips={past} empty="No past trips in this range." />}
      </div>

      <ResponsiveSheet open={adding} onOpenChange={setAdding}>
        <SheetHeader className="p-5 pb-0">
          <SheetTitle className="text-base">Add a trip</SheetTitle>
          <SheetDescription>Same booking again (provider, title, start) updates it instead of adding a twin.</SheetDescription>
        </SheetHeader>
        <form onSubmit={save} className="grid grid-cols-2 gap-x-4 gap-y-4 p-5">
          <Field label="Kind" htmlFor="trip-kind"><select id="trip-kind" className={inputClass} value={d.kind} onChange={set("kind")}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
          <Field label="Provider" htmlFor="trip-provider"><input id="trip-provider" required placeholder="Wyndham" className={inputClass} value={d.provider} onChange={set("provider")} /></Field>
          <Field label="Title" htmlFor="trip-title" className="col-span-2"><input id="trip-title" required placeholder="Days Inn Springfield, 2 nights" className={inputClass} value={d.title} onChange={set("title")} /></Field>
          <Field label="Start" htmlFor="trip-start"><input id="trip-start" type="date" required className={inputClass} value={d.start} onChange={set("start")} /></Field>
          <Field label="End" htmlFor="trip-end"><input id="trip-end" type="date" min={d.start || undefined} className={inputClass} value={d.end} onChange={set("end")} /></Field>
          <Field label="Cost" htmlFor="trip-cost"><input id="trip-cost" inputMode="decimal" placeholder="$" className={cn(inputClass, "num")} value={d.cost} onChange={set("cost")} /></Field>
          <Field label="Booked via" htmlFor="trip-via"><input id="trip-via" placeholder="direct" className={inputClass} value={d.via} onChange={set("via")} /></Field>
          <Field label="Program" htmlFor="trip-program" className="col-span-2">
            <select id="trip-program" className={inputClass} value={d.programId} onChange={set("programId")}>
              <option value="">None</option>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <div className="col-span-2 flex items-center justify-between gap-3 pt-1">
            <code className="text-muted-foreground num hidden truncate text-[11px] sm:block">fin trips add --kind {d.kind} --provider …</code>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Add trip"}</Button>
          </div>
        </form>
      </ResponsiveSheet>
    </section>
  );
}
