import { describe, expect, test } from "bun:test";
import { db } from "@/db";
import { loyaltyPrograms, tripBookings } from "@/db/schema";
import { importTravel, planTravelImport, splitBookedVia, travelExportSchema } from "./travel-import";
import { upsertProgram } from "./travel";

// Invented data in the export's shape; the real file never enters the repo.
const EXPORT = {
  account: "someone@example.com",
  programs: [
    { name: "Import United MileagePlus", kind: "airline", memberLast4: "KL2 (only last 3 shown unmasked)", statusTier: null, balance: null, balanceAsOf: null, evidence: "enrolled Oct 9 2026" },
    { name: "Import Marriott Bonvoy", kind: "hotel", memberLast4: "0123", statusTier: "Member", balance: null, balanceAsOf: null, evidence: "Welcome Jul 24 2026" },
    { name: "Import Hyatt", kind: "hotel", memberLast4: null, statusTier: "Member", balance: 0, balanceAsOf: "2026-10-10", evidence: "Welcome Oct 10 2026" },
    { name: "Import Chase Freedom Unlimited", kind: "card", memberLast4: null, statusTier: null, balance: null, balanceAsOf: null, evidence: "$200 bonus" },
  ],
  trips: [
    { kind: "flight", provider: "United Airlines", title: "LAX -> SEA import", startDate: "2019-03-25", endDate: "2019-03-25", costCents: 2848, pointsUsed: null, bookedVia: "united.com", status: "completed", confirmation: "ABC123", location: "x" },
    { kind: "hotel", provider: "IHG - Holiday Inn import", title: "1 night", startDate: "2019-07-02", endDate: "2019-07-03", costCents: null, pointsUsed: "anniversary night credit (Jane Doe)", bookedVia: "Father (Jane Doe)", status: "completed" },
    { kind: "hotel", provider: "Hyatt - Andaz import", title: "4 nights", startDate: "2019-10-06", endDate: "2019-10-10", costCents: null, pointsUsed: null, bookedVia: "Exampletravels (OTA; first payment declined, then charged via a processor)", status: "completed" },
  ],
};

describe("splitBookedVia", () => {
  test("short label, long text to the note, someone's full name dropped", () => {
    expect(splitBookedVia("united.com")).toEqual({ bookedVia: "united.com" });
    expect(splitBookedVia("Father (Jane Doe)")).toEqual({ bookedVia: "Father" });
    expect(splitBookedVia("Group rate (Acme)")).toEqual({ bookedVia: "Group rate", note: "Group rate (Acme)" });
    expect(splitBookedVia("alaskaair.com (paid on father's card)")).toEqual({ bookedVia: "alaskaair.com", note: "alaskaair.com (paid on father's card)" });
    expect(splitBookedVia("x".repeat(60)).bookedVia).toHaveLength(40);
    expect(splitBookedVia(null)).toEqual({});
  });
});

describe("planTravelImport", () => {
  const data = travelExportSchema.parse(EXPORT);

  test("empty store: every program and trip is new; bad last-4 dropped; trips link by brand", () => {
    const p = planTravelImport(data, { programs: [], trips: [] });
    expect(p.programs.map((s) => s.action)).toEqual(["create", "create", "create", "create"]);
    const united = p.programs[0]!;
    expect(united.action === "create" && united.input.memberLast4).toBeUndefined();
    const marriott = p.programs[1]!;
    expect(marriott.action === "create" && marriott.input).toMatchObject({ memberLast4: "0123", statusTier: "Member", note: "from Gmail: Welcome Jul 24 2026" });
    const hyatt = p.programs[2]!;
    expect(hyatt.action === "create" && hyatt.input).toMatchObject({ balance: 0, balanceAsOf: "2026-10-10" });
    expect(p.trips.map((t) => [t.action, t.input.programName])).toEqual([["create", "Import United MileagePlus"], ["create", undefined], ["create", "Import Hyatt"]]);
    expect(JSON.stringify(p)).not.toContain("Jane Doe");
    expect(JSON.stringify(p)).not.toContain("ABC123");
  });

  test("a card whose brand is already held under another name is skipped", () => {
    const p = planTravelImport(data, { programs: [{ id: 1, name: "Chase Ultimate Rewards", statusTier: null, memberLast4: null, note: "mine", balanceAsOf: null }], trips: [] });
    expect(p.programs[3]).toEqual({ action: "covered", name: "Import Chase Freedom Unlimited", by: "Chase Ultimate Rewards" });
  });

  test("stored rows: blanks filled, nothing overwritten, same trip not repeated", () => {
    const p = planTravelImport(data, {
      programs: [
        { id: 7, name: "import marriott bonvoy", statusTier: "Gold", memberLast4: null, note: "typed by me", balanceAsOf: null },
        { id: 8, name: "Import Hyatt", statusTier: "Member", memberLast4: null, note: "from Gmail: x", balanceAsOf: "2026-10-10" },
      ],
      trips: [{ provider: "UNITED AIRLINES", title: "LAX -> SEA import", startDate: "2019-03-25" }],
    });
    expect(p.programs[1]).toEqual({ action: "fill", name: "import marriott bonvoy", id: 7, patch: { memberLast4: "0123" } });
    expect(p.programs[2]).toEqual({ action: "unchanged", name: "Import Hyatt" });
    expect(p.trips.map((t) => t.action)).toEqual(["unchanged", "create", "create"]);
  });

  test("rejects a malformed file instead of guessing", () => {
    expect(() => travelExportSchema.parse({ trips: [{ kind: "boat", provider: "x", title: "y", startDate: "2026-01-01" }] })).toThrow();
    expect(() => travelExportSchema.parse({ programs: [{ name: "x", kind: "hotel", balance: -1 }] })).toThrow();
  });
});

describe("importTravel", () => {
  test("dry run writes nothing; the real run writes once; a re-run adds nothing", async () => {
    await upsertProgram({ name: "Chase Ultimate Rewards", kind: "card", balance: 25_000, note: "keep me" });
    const before = { p: (await db.select().from(loyaltyPrograms)).length, t: (await db.select().from(tripBookings)).length };

    const dry = await importTravel(EXPORT, { dryRun: true });
    expect(dry.programs).toEqual({ created: 3, filled: 0, unchanged: 0, covered: 1 });
    expect(dry.trips).toEqual({ created: 3, unchanged: 0 });
    expect((await db.select().from(loyaltyPrograms)).length).toBe(before.p);

    const first = await importTravel(EXPORT);
    expect(first.trips.created).toBe(3);
    const programs = await db.select().from(loyaltyPrograms);
    const trips = await db.select().from(tripBookings);
    expect(programs.length).toBe(before.p + 3);
    expect(trips.length).toBe(before.t + 3);
    const hyattId = programs.find((p) => p.name === "Import Hyatt")!.id;
    expect(trips.find((t) => t.provider === "Hyatt - Andaz import")).toMatchObject({ programId: hyattId, bookedVia: "Exampletravels", source: "gmail", status: "completed" });
    expect(trips.find((t) => t.provider === "IHG - Holiday Inn import")).toMatchObject({ programId: null, bookedVia: "Father", note: "points: anniversary night credit", pointsUsed: null });
    expect(programs.find((p) => p.name === "Chase Ultimate Rewards")).toMatchObject({ balance: 25_000, note: "keep me" });

    const again = await importTravel(EXPORT);
    expect(again.programs).toEqual({ created: 0, filled: 0, unchanged: 3, covered: 1 });
    expect(again.trips).toEqual({ created: 0, unchanged: 3 });
    expect((await db.select().from(tripBookings)).length).toBe(before.t + 3);
  });
});
