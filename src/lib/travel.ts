import "server-only";
import { asc, eq, like, or, sql } from "drizzle-orm";
import { format } from "date-fns";
import { z } from "zod";
import { db } from "@/db";
import { loyaltyKind, loyaltyPrograms, transactions, tripBookings, tripKind } from "@/db/schema";
import { bestCardFor, listCards } from "@/lib/cards";
import { brandFor } from "@/lib/travel-brands";
import { defaultValuation } from "@/lib/travel-advisor";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v || null));

/** Never store a full member number: exactly four letters/digits or nothing. */
const programInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(loyaltyKind),
  balance: z.number().int().min(0).max(100_000_000).optional(),
  statusTier: optText(40),
  memberLast4: z.string().trim().regex(/^[A-Za-z0-9]{4}$/, "memberLast4 must be exactly 4 characters").nullish(),
  valueCentsPerPoint: z.number().int().min(1).max(1000).nullish(),
  note: optText(300),
  balanceAsOf: isoDay.nullish(),
}).strict();
export type ProgramInput = z.input<typeof programInput>;

const tripInput = z.object({
  kind: z.enum(tripKind),
  provider: z.string().trim().min(1).max(80),
  programId: z.number().int().positive().nullish(),
  title: z.string().trim().min(1).max(120),
  startDate: isoDay,
  endDate: isoDay.nullish(),
  location: optText(120),
  costCents: z.number().int().min(0).nullish(),
  pointsUsed: z.number().int().min(0).nullish(),
  bookedVia: optText(40),
  status: z.enum(["booked", "completed", "cancelled"]).optional(),
  note: optText(300),
  source: z.enum(["manual", "gmail"]).optional(),
}).strict();
export type TripInput = z.input<typeof tripInput>;

/**
 * Insert or update by the unique program name. An omitted balance keeps the
 * stored one, so an importer that only knows the membership cannot zero it.
 */
export async function upsertProgram(input: ProgramInput) {
  const p = programInput.parse(input);
  const set = Object.fromEntries(Object.entries({ ...p, updatedAt: new Date() }).filter(([, v]) => v !== undefined));
  const [row] = await db.insert(loyaltyPrograms).values({ ...p, balance: p.balance ?? 0 })
    .onConflictDoUpdate({ target: loyaltyPrograms.name, set }).returning();
  return row;
}

export async function updateProgram(id: number, patch: Partial<ProgramInput>) {
  const p = programInput.partial().parse(patch);
  const [row] = await db.update(loyaltyPrograms).set({ ...p, updatedAt: new Date() }).where(eq(loyaltyPrograms.id, id)).returning();
  if (!row) throw new Error(`no loyalty program #${id}`);
  return row;
}

export async function deleteProgram(id: number) {
  await db.delete(loyaltyPrograms).where(eq(loyaltyPrograms.id, id));
}

/** Same provider + title + start date is the same booking, whether typed or re-imported from Gmail. */
export async function saveTrip(input: TripInput) {
  const t = tripInput.parse(input);
  const existing = (await db.select().from(tripBookings).where(eq(tripBookings.startDate, t.startDate)))
    .find((r) => r.provider.toLowerCase() === t.provider.toLowerCase() && r.title.toLowerCase() === t.title.toLowerCase());
  if (existing) {
    const [row] = await db.update(tripBookings).set(t).where(eq(tripBookings.id, existing.id)).returning();
    return { trip: row, created: false };
  }
  const [row] = await db.insert(tripBookings).values(t).returning();
  return { trip: row, created: true };
}

export async function updateTrip(id: number, patch: Partial<TripInput>) {
  const [row] = await db.update(tripBookings).set(tripInput.partial().parse(patch)).where(eq(tripBookings.id, id)).returning();
  if (!row) throw new Error(`no trip #${id}`);
  return row;
}

export async function deleteTrip(id: number) {
  await db.delete(tripBookings).where(eq(tripBookings.id, id));
}

export type ProgramView = typeof loyaltyPrograms.$inferSelect & {
  /** Stored value, else the dated default for the program, else null. */
  effectiveHundredthsCpp: number | null;
  valueIsDefault: boolean;
  estValueCents: number;
};

export async function listPrograms(): Promise<ProgramView[]> {
  const rows = await db.select().from(loyaltyPrograms).orderBy(asc(loyaltyPrograms.kind), asc(loyaltyPrograms.name));
  return rows.map((r) => {
    const fallback = defaultValuation(r.name)?.hundredthsCpp ?? null;
    const effective = r.valueCentsPerPoint ?? fallback;
    return { ...r, effectiveHundredthsCpp: effective, valueIsDefault: r.valueCentsPerPoint == null && fallback != null, estValueCents: Math.round((r.balance * (effective ?? 0)) / 100) };
  });
}

export async function findProgram(name: string) {
  const programs = await listPrograms();
  const lower = name.toLowerCase();
  return programs.find((p) => p.name.toLowerCase() === lower) ?? programs.find((p) => p.name.toLowerCase().includes(lower));
}

const nightsBetween = (a: string, b: string | null) =>
  b ? Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)) : 0;

export type ProgramYear = { programId: number | null; name: string; stays: number; nights: number; flights: number; spendCents: number; pointsUsed: number };

/** Everything /travel and `fin points|trips` show. `today` is a local YYYY-MM-DD. */
export async function getTravelOverview(today = format(new Date(), "yyyy-MM-dd")) {
  const [programs, trips] = await Promise.all([
    listPrograms(),
    db.select().from(tripBookings).orderBy(asc(tripBookings.startDate)),
  ]);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const live = trips.filter((t) => t.status !== "cancelled");
  const upcoming = live.filter((t) => t.startDate >= today);
  const pastThisYear = live.filter((t) => t.startDate < today && t.startDate >= yearStart).reverse();
  const names = new Map(programs.map((p) => [p.id, p.name]));
  const byProgram = new Map<string, ProgramYear>();
  for (const t of live.filter((t) => t.startDate >= yearStart && t.startDate.slice(0, 4) === today.slice(0, 4))) {
    const key = t.programId ? `id:${t.programId}` : `p:${t.provider.toLowerCase()}`;
    const row = byProgram.get(key) ?? { programId: t.programId, name: (t.programId && names.get(t.programId)) || t.provider, stays: 0, nights: 0, flights: 0, spendCents: 0, pointsUsed: 0 };
    if (t.kind === "hotel") { row.stays++; row.nights += nightsBetween(t.startDate, t.endDate); }
    if (t.kind === "flight") row.flights++;
    row.spendCents += t.costCents ?? 0;
    row.pointsUsed += t.pointsUsed ?? 0;
    byProgram.set(key, row);
  }
  return {
    today,
    programs,
    totalValueCents: programs.reduce((s, p) => s + p.estValueCents, 0),
    upcoming,
    pastThisYear,
    thisYear: [...byProgram.values()].sort((a, b) => b.nights - a.nights || b.spendCents - a.spendCents),
  };
}
export type TravelOverview = Awaited<ReturnType<typeof getTravelOverview>>;

/* ------------------------- brand charges and compare ------------------------ */

export type BrandCharge = { id: number; date: string; merchant: string; amountCents: number; account: string | null };

/**
 * The latest ledger row whose description carries each program's brand
 * (wyndham, alaska air, booking.com, …), keyed by program name. Programs whose
 * brand has no merchant text, or no matching row, are absent.
 */
export async function lastBrandCharges(names: string[]): Promise<Record<string, BrandCharge>> {
  const out: Record<string, BrandCharge> = {};
  await Promise.all(names.map(async (name) => {
    const terms = brandFor(name).merchants;
    if (!terms.length) return;
    const row = await db.query.transactions.findFirst({
      where: or(...terms.map((t) => like(sql`lower(${transactions.merchantRaw})`, `%${t}%`))),
      with: { account: true },
      orderBy: (t, { desc }) => [desc(t.postedAt)],
    });
    if (row) out[name] = { id: row.id, date: format(row.postedAt, "yyyy-MM-dd"), merchant: row.merchantRaw, amountCents: row.amountCents, account: row.account?.name ?? null };
  }));
  return out;
}

/**
 * The cards behind the three-way hotel comparison: the card point value and
 * portal earn (whichever card has a "via … travel" travel rate, Freedom
 * Unlimited's 5% in Chase Travel), and the best card for a direct travel
 * charge from the ranking every other "which card?" answer uses.
 */
export async function compareDefaults() {
  const [cards, direct, chase] = await Promise.all([listCards({ activeOnly: true }), bestCardFor({ category: "travel" }), findProgram("chase")]);
  const portal = cards
    .flatMap((c) => c.rates.filter((r) => r.via && r.category === "travel").map((r) => ({ card: c.name, via: r.via!, earnBp: r.rateBp, pointValue: c.pointValue })))
    .sort((a, b) => b.earnBp * b.pointValue - a.earnBp * a.pointValue)
    .find((p) => /chase/i.test(p.via));
  const best = direct.ranked[0];
  const pointValue = chase?.effectiveHundredthsCpp ?? portal?.pointValue ?? 100;
  return {
    pointValueHundredthsCpp: pointValue,
    pointsProgram: chase?.name ?? "Chase Ultimate Rewards",
    portalCard: portal?.card ?? "Chase Freedom Unlimited",
    portalVia: portal?.via ?? "Chase Travel",
    // The portal rate is in points; value it at what a point is worth.
    portalEarnBp: Math.round(((portal?.earnBp ?? 500) * pointValue) / 100),
    directCard: best?.name ?? "your best card",
    directCardBp: best?.valueBp ?? 100,
  };
}
export type CompareDefaults = Awaited<ReturnType<typeof compareDefaults>>;
