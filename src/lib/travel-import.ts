import "server-only";
import { z } from "zod";
import { db } from "@/db";
import { loyaltyKind, loyaltyPrograms, tripBookings, tripKind } from "@/db/schema";
import { brandFor } from "@/lib/travel-brands";
import { saveTrip, upsertProgram, type ProgramInput, type TripInput } from "@/lib/travel";

/**
 * `fin trips import FILE.json`: loyalty programs and bookings found in email.
 * The file holds personal data, so it is read from a path and never kept in
 * the repo. Shape (unknown keys such as `account`, `evidence`, `location`,
 * `confirmation` are ignored or only feed the note):
 *
 *   {
 *     "programs": [{ "name": "World of Hyatt", "kind": "card|airline|hotel|other",
 *                    "memberLast4": "0123" | null, "statusTier": "Member" | null,
 *                    "balance": 0 | null, "balanceAsOf": "YYYY-MM-DD" | null,
 *                    "evidence": "Welcome to World of Hyatt - Oct 10 2026" }],
 *     "trips": [{ "kind": "flight|hotel|car|other", "provider": "Air Canada",
 *                 "title": "SFO -> YUL -> YOW", "startDate": "YYYY-MM-DD",
 *                 "endDate": "YYYY-MM-DD" | null, "costCents": 3898 | null,
 *                 "pointsUsed": 0 | "free text" | null, "bookedVia": "aircanada.com (corporate code applied)" | null,
 *                 "status": "booked|completed|cancelled" }]
 *   }
 *
 * Idempotent and additive: a program whose name is already stored only gets
 * its empty fields filled; one whose brand is already stored under another
 * name (a Chase card when "Chase Ultimate Rewards" exists) is skipped; a trip
 * with the same provider, title and start date is left as it is.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const text = z.string().trim().nullish();
export const travelExportSchema = z.object({
  programs: z.array(z.object({
    name: z.string().trim().min(1),
    kind: z.enum(loyaltyKind),
    memberLast4: text,
    statusTier: text,
    balance: z.number().int().min(0).nullish(),
    balanceAsOf: day.nullish(),
    evidence: text,
  })).default([]),
  trips: z.array(z.object({
    kind: z.enum(tripKind),
    provider: z.string().trim().min(1),
    title: z.string().trim().min(1),
    startDate: day,
    endDate: day.nullish(),
    costCents: z.number().int().min(0).nullish(),
    /** A count of points, or free text ("anniversary night credit") that goes to the note. */
    pointsUsed: z.union([z.number().int().min(0), z.string().trim()]).nullish(),
    bookedVia: text,
    status: z.enum(["booked", "completed", "cancelled"]).optional(),
  })).default([]),
});
export type TravelExport = z.infer<typeof travelExportSchema>;

/** "Father (Jane Q Doe)" → "Father": a parenthesised two- or three-word proper name is someone else's, not booking detail. */
const dropPersonName = (s: string) => s.replace(/\s*\((?:[A-Z][a-z]+ ){1,2}[A-Z][a-z]+\)/g, "").trim();

/** bookedVia is a short label (≤40); the full text, when longer than that label, goes to the note. */
export function splitBookedVia(raw: string | null | undefined): { bookedVia?: string; note?: string } {
  if (!raw?.trim()) return {};
  const full = dropPersonName(raw.trim());
  const bookedVia = full.split(" (")[0]!.slice(0, 40).trim();
  return full === bookedVia ? { bookedVia } : { bookedVia, note: full.slice(0, 300) };
}

type StoredProgram = { id: number; name: string; statusTier: string | null; memberLast4: string | null; note: string | null; balanceAsOf: string | null };
type StoredTrip = { provider: string; title: string; startDate: string };

export type ProgramStep =
  | { action: "create"; name: string; input: ProgramInput }
  | { action: "fill"; name: string; id: number; patch: Partial<ProgramInput> }
  | { action: "unchanged"; name: string }
  | { action: "covered"; name: string; by: string };
export type TripStep = { action: "create" | "unchanged"; label: string; input: TripInput & { programName?: string } };

const brandKey = (name: string) => brandFor(name).key;
const tripKey = (t: StoredTrip) => `${t.provider.toLowerCase()}|${t.title.toLowerCase()}|${t.startDate}`;

/** Pure: what an import would do against what is stored. */
export function planTravelImport(data: TravelExport, stored: { programs: StoredProgram[]; trips: StoredTrip[] }) {
  const programs: ProgramStep[] = [];
  const known = [...stored.programs.map((p) => p.name)];
  for (const p of data.programs) {
    const last4 = p.memberLast4 && /^[A-Za-z0-9]{4}$/.test(p.memberLast4) ? p.memberLast4 : null;
    const input: ProgramInput = {
      name: p.name, kind: p.kind,
      ...(p.balance != null ? { balance: p.balance, balanceAsOf: p.balanceAsOf ?? null } : {}),
      ...(p.statusTier ? { statusTier: p.statusTier } : {}),
      ...(last4 ? { memberLast4: last4 } : {}),
      ...(p.evidence ? { note: `from Gmail: ${p.evidence.slice(0, 180)}` } : {}),
    };
    const same = stored.programs.find((s) => s.name.toLowerCase() === p.name.toLowerCase());
    if (same) {
      // Never overwrite what is stored (a balance typed later, an edited note); only fill blanks.
      const patch: Partial<ProgramInput> = {};
      if (!same.statusTier && input.statusTier) patch.statusTier = input.statusTier;
      if (!same.memberLast4 && input.memberLast4) patch.memberLast4 = input.memberLast4;
      if (!same.note && input.note) patch.note = input.note;
      programs.push(Object.keys(patch).length ? { action: "fill", name: same.name, id: same.id, patch } : { action: "unchanged", name: same.name });
      continue;
    }
    const key = brandKey(p.name);
    const sibling = key === "other" ? undefined : known.find((n) => brandKey(n) === key);
    if (sibling) { programs.push({ action: "covered", name: p.name, by: sibling }); continue; }
    programs.push({ action: "create", name: p.name, input });
    known.push(p.name);
  }

  // A trip belongs to the program of its brand, whether stored or created above.
  const seen = new Set(stored.trips.map(tripKey));
  const trips: TripStep[] = data.trips.map((t) => {
    const key = brandKey(t.provider);
    const programName = key === "other" ? undefined : known.find((n) => brandKey(n) === key);
    const via = splitBookedVia(t.bookedVia);
    const pointsNote = typeof t.pointsUsed === "string" && t.pointsUsed ? dropPersonName(t.pointsUsed) : null;
    const note = [via.note, pointsNote && `points: ${pointsNote}`].filter(Boolean).join("; ").slice(0, 300);
    const input = {
      kind: t.kind, provider: t.provider, title: t.title, startDate: t.startDate,
      ...(t.endDate ? { endDate: t.endDate } : {}),
      ...(t.costCents != null ? { costCents: t.costCents } : {}),
      ...(typeof t.pointsUsed === "number" ? { pointsUsed: t.pointsUsed } : {}),
      ...(via.bookedVia ? { bookedVia: via.bookedVia } : {}),
      ...(note ? { note } : {}),
      ...(t.status ? { status: t.status } : {}),
      source: "gmail" as const,
      ...(programName ? { programName } : {}),
    };
    const k = tripKey(t);
    const action = seen.has(k) ? "unchanged" as const : "create" as const;
    seen.add(k);
    return { action, label: `${t.startDate} ${t.provider}: ${t.title}`, input };
  });
  return { programs, trips };
}
export type TravelImportPlan = ReturnType<typeof planTravelImport>;

const count = <T extends { action: string }>(steps: T[], action: string) => steps.filter((s) => s.action === action).length;

/** Parse, plan, and (unless dryRun) apply. Programs first, so new trips can link to them. */
export async function importTravel(raw: unknown, opts: { dryRun?: boolean } = {}) {
  const data = travelExportSchema.parse(raw);
  const [programRows, tripRows] = await Promise.all([db.select().from(loyaltyPrograms), db.select().from(tripBookings)]);
  const plan = planTravelImport(data, { programs: programRows, trips: tripRows });
  if (!opts.dryRun) {
    for (const s of plan.programs) {
      if (s.action === "create") await upsertProgram(s.input);
      if (s.action === "fill") await upsertProgram({ name: s.name, kind: programRows.find((p) => p.id === s.id)!.kind, ...s.patch });
    }
    const ids = new Map((await db.select().from(loyaltyPrograms)).map((p) => [p.name, p.id]));
    for (const s of plan.trips) {
      if (s.action !== "create") continue;
      const { programName, ...trip } = s.input;
      await saveTrip({ ...trip, ...(programName && ids.get(programName) ? { programId: ids.get(programName) } : {}) });
    }
  }
  return {
    dryRun: !!opts.dryRun,
    programs: { created: count(plan.programs, "create"), filled: count(plan.programs, "fill"), unchanged: count(plan.programs, "unchanged"), covered: count(plan.programs, "covered") },
    trips: { created: count(plan.trips, "create"), unchanged: count(plan.trips, "unchanged") },
    plan,
  };
}
export type TravelImportResult = Awaited<ReturnType<typeof importTravel>>;
