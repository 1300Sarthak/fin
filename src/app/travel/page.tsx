import { db } from "@/db";
import { tripBookings } from "@/db/schema";
import { asc } from "drizzle-orm";
import { Disclosure, inRange, Money, PageHeader, RangePicker, resolveRange, Section, Stat, StatGroup } from "@/components/kit";
import { TravelPrograms, type ProgramRow } from "@/components/travel-programs";
import { TravelCalculator } from "@/components/travel-calculator";
import { TravelTrips, type TripRow } from "@/components/travel-trips";
import { compareDefaults, getTravelOverview, lastBrandCharges } from "@/lib/travel";
import { bookingTips, VALUATIONS_AS_OF, type ProgramKind } from "@/lib/travel-advisor";
import { brandFor } from "@/lib/travel-brands";
import { formatDate, formatUSD } from "@/lib/format";
import { txnHref } from "@/lib/txn-filter-core";

export const dynamic = "force-dynamic";

const nightsBetween = (a: string, b: string | null) =>
  b ? Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)) : 0;

export default async function TravelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const range = resolveRange(sp, { fallback: "ytd" });
  const [data, allTrips, defaults] = await Promise.all([
    getTravelOverview(),
    db.select().from(tripBookings).orderBy(asc(tripBookings.startDate)),
    compareDefaults(),
  ]);
  const charges = await lastBrandCharges(data.programs.map((p) => p.name));
  const live = allTrips.filter((t) => t.status !== "cancelled");
  const inPeriod = live.filter((t) => t.startDate < data.today && inRange(range, t.startDate));

  // A trip belongs to a program when linked, or when its provider is the same brand.
  const brandOf = (name: string) => brandFor(name).key;
  const belongs = (t: (typeof live)[number], p: { id: number; name: string }) =>
    t.programId === p.id || (t.programId == null && brandOf(p.name) !== "other" && brandOf(t.provider) === brandOf(p.name));

  const programs: ProgramRow[] = data.programs.map((p) => {
    const mine = live.filter((t) => belongs(t, p));
    const period = mine.filter((t) => inPeriod.includes(t));
    const terms = brandFor(p.name).merchants;
    return {
      id: p.id, name: p.name, kind: p.kind, balance: p.balance, statusTier: p.statusTier, memberLast4: p.memberLast4,
      effectiveHundredthsCpp: p.effectiveHundredthsCpp, valueIsDefault: p.valueIsDefault, estValueCents: p.estValueCents,
      note: p.note, balanceAsOf: p.balanceAsOf, updatedAt: p.updatedAt.toISOString(),
      activity: {
        flights: period.filter((t) => t.kind === "flight").length,
        stays: period.filter((t) => t.kind === "hotel").length,
        nights: period.filter((t) => t.kind === "hotel").reduce((s, t) => s + nightsBetween(t.startDate, t.endDate), 0),
        spendCents: period.reduce((s, t) => s + (t.costCents ?? 0), 0),
      },
      lastCharge: charges[p.name] ?? null,
      merchantHref: terms.length ? txnHref({ merchant: charges[p.name] ? terms.find((m) => charges[p.name].merchant.toLowerCase().includes(m)) ?? terms[0] : terms[0] }) : null,
      trips: mine.toReversed().slice(0, 8).map((t) => ({ id: t.id, kind: t.kind, title: t.title, startDate: t.startDate, endDate: t.endDate, costCents: t.costCents, pointsUsed: t.pointsUsed })),
    };
  });

  const programName = new Map(data.programs.map((p) => [p.id, p.name]));
  const toRow = (t: (typeof live)[number]): TripRow => ({
    id: t.id, kind: t.kind, title: t.title, provider: t.provider, startDate: t.startDate, endDate: t.endDate, costCents: t.costCents,
    pointsUsed: t.pointsUsed, bookedVia: t.bookedVia, source: t.source, program: (t.programId && programName.get(t.programId)) || null,
  });

  // Providers with trips but no program held: still counted, so nothing from "by program" is lost.
  const loose = new Map<string, { flights: number; stays: number; nights: number; spendCents: number }>();
  for (const t of inPeriod.filter((t) => !data.programs.some((p) => belongs(t, p)))) {
    const r = loose.get(t.provider) ?? { flights: 0, stays: 0, nights: 0, spendCents: 0 };
    if (t.kind === "flight") r.flights++;
    if (t.kind === "hotel") { r.stays++; r.nights += nightsBetween(t.startDate, t.endDate); }
    r.spendCents += t.costCents ?? 0;
    loose.set(t.provider, r);
  }

  const held = data.programs.map((p) => ({ name: p.name, kind: p.kind as ProgramKind }));
  const hotelTips = bookingTips(held, "hotel");
  const flightTips = bookingTips(held, "flight").filter((t) => !hotelTips.includes(t));
  const totalPoints = data.programs.reduce((s, p) => s + p.balance, 0);
  const nights = inPeriod.filter((t) => t.kind === "hotel").reduce((s, t) => s + nightsBetween(t.startDate, t.endDate), 0);
  const flights = inPeriod.filter((t) => t.kind === "flight").length;
  const calc = typeof sp.calc === "string" ? sp.calc : undefined;

  return <>
    <PageHeader
      title="Points & travel"
      description="What you hold, what it is worth, and whether to spend points or cash on the next booking."
      actions={<RangePicker value={range} fallback="ytd" />}
    />

    <StatGroup cols={4}>
      <Stat label="Points value" value={<Money cents={data.totalValueCents} wholeDollars />} sub={`${totalPoints.toLocaleString("en-US")} pts · ${data.programs.length} programs`} help={`Balances × cents per point; values marked est. are ${VALUATIONS_AS_OF} defaults.`} />
      <Stat label="Upcoming trips" value={data.upcoming.length} sub={data.upcoming[0] ? `Next ${formatDate(data.upcoming[0].startDate)}` : "Nothing booked"} help={data.upcoming[0] ? `Next: ${data.upcoming[0].title}` : undefined} />
      <Stat label="Flights" value={flights} sub={range.label} />
      <Stat label="Hotel nights" value={nights} sub={`${inPeriod.filter((t) => t.kind === "hotel").length} stays · ${range.label}`} />
    </StatGroup>

    <div className="mt-10">
      <TravelPrograms programs={programs} rangeLabel={range.label} />
    </div>

    <div className="mt-10">
      <TravelTrips upcoming={data.upcoming.map(toRow)} past={inPeriod.toReversed().map(toRow)} programs={data.programs.map((p) => ({ id: p.id, name: p.name }))} rangeLabel={range.label} />
    </div>

    {loose.size > 0 && (
      <Section className="mt-10" title="Other providers" description={`Trips with no program held · ${range.label}`} surface>
        <ul className="divide-y">
          {[...loose].map(([name, r]) => (
            <li key={name} className="flex items-center justify-between gap-3 px-4 py-2.5 md:px-5">
              <span className="truncate text-sm">{name}</span>
              <span className="text-muted-foreground num shrink-0 text-xs">{[r.stays && `${r.stays} stay${r.stays === 1 ? "" : "s"} · ${r.nights} night${r.nights === 1 ? "" : "s"}`, r.flights && `${r.flights} flight${r.flights === 1 ? "" : "s"}`, formatUSD(r.spendCents, false)].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
      </Section>
    )}

    <Section id="calculator" className="mt-10" title="Points or cash?" description="Three ways to pay for a hotel, each net of what it earns back.">
      <TravelCalculator key={calc ?? "default"} initialHotel={calc} defaults={defaults} hotels={data.programs.filter((p) => p.kind === "hotel").map((p) => ({ name: p.name, hundredthsCpp: p.effectiveHundredthsCpp }))} />
    </Section>

    <Disclosure className="mt-8" summary="Booking tips">
      <div className="grid gap-6 text-[13px] leading-relaxed md:grid-cols-2">
        {[["Hotels", hotelTips], ["Flights", flightTips]].map(([title, list]) => (list as string[]).length > 0 && (
          <div key={title as string}>
            <h3 className="font-semibold">{title as string}</h3>
            <ul className="text-muted-foreground mt-1.5 list-disc space-y-1 pl-5">{(list as string[]).map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground mt-3 text-xs">Stays and nights count toward elite status only when booked direct.</p>
    </Disclosure>
  </>;
}
