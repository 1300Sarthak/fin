import { describe, expect, test } from "bun:test";
import { getTravelOverview, saveTrip, updateProgram, upsertProgram } from "./travel";

describe("travel store", () => {
  test("upsert by name keeps the balance when an importer omits it", async () => {
    const a = await upsertProgram({ name: "Chase Ultimate Rewards", kind: "card", balance: 25_000, valueCentsPerPoint: 100, note: "FU only" });
    const b = await upsertProgram({ name: "Chase Ultimate Rewards", kind: "card", statusTier: null });
    expect(b.id).toBe(a.id);
    expect(b.balance).toBe(25_000);
    expect(b.note).toBe("FU only");
  });

  test("refuses anything but a 4-character member suffix", async () => {
    await expect(upsertProgram({ name: "Wyndham Rewards", kind: "hotel", memberLast4: "123456789" })).rejects.toThrow();
    const w = await upsertProgram({ name: "Wyndham Rewards", kind: "hotel", memberLast4: "6789", balance: 3_000 });
    expect(w.memberLast4).toBe("6789");
    await expect(updateProgram(w.id, { balance: -5 })).rejects.toThrow();
  });

  test("overview: values, upcoming vs past, nights per program", async () => {
    const w = await upsertProgram({ name: "Wyndham Rewards", kind: "hotel" });
    await saveTrip({ kind: "hotel", provider: "La Quinta", programId: w.id, title: "La Quinta Springfield", startDate: "2026-11-11", endDate: "2026-11-13", costCents: 10_400 });
    await saveTrip({ kind: "hotel", provider: "La Quinta", programId: w.id, title: "La Quinta Riverside", startDate: "2026-03-01", endDate: "2026-03-02", costCents: 9_000, source: "gmail" });
    await saveTrip({ kind: "flight", provider: "Southwest", title: "SJC → LAX", startDate: "2025-12-01" });
    // Re-import of the same booking updates instead of duplicating.
    const again = await saveTrip({ kind: "hotel", provider: "la quinta", title: "La Quinta Riverside", startDate: "2026-03-01", endDate: "2026-03-02", costCents: 9_100, source: "gmail" });
    expect(again.created).toBe(false);

    const o = await getTravelOverview("2026-11-11");
    const ur = o.programs.find((p) => p.name === "Chase Ultimate Rewards")!;
    expect(ur.estValueCents).toBe(25_000);
    const wy = o.programs.find((p) => p.name === "Wyndham Rewards")!;
    expect(wy.valueIsDefault).toBe(true);
    expect(wy.estValueCents).toBe(Math.round(3_000 * wy.effectiveHundredthsCpp! / 100));
    expect(o.totalValueCents).toBe(ur.estValueCents + wy.estValueCents);
    expect(o.upcoming.map((t) => t.title)).toEqual(["La Quinta Springfield"]);
    expect(o.pastThisYear.map((t) => t.title)).toEqual(["La Quinta Riverside"]);
    const year = o.thisYear.find((y) => y.programId === w.id)!;
    expect(year).toMatchObject({ name: "Wyndham Rewards", stays: 2, nights: 3, spendCents: 19_500 });
    expect(o.thisYear.some((y) => y.name === "Southwest")).toBe(false);
  });
});
