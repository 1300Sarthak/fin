import { describe, expect, test } from "bun:test";
import { db } from "@/db";
import { accounts, holdings } from "@/db/schema";
import { getInvestmentValueGap, investmentValueGapNote } from "./holdings";

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

describe("investment value gap", () => {
  test("splits account value into positions plus uninvested cash, and counts positions held elsewhere", async () => {
    const before = await getInvestmentValueGap();
    const [broker, cashMgmt] = await db.insert(accounts).values([
      { name: "Gap Brokerage", type: "brokerage", source: "manual", currentBalanceCents: 100_000 },
      { name: "Gap Cash Management", type: "checking", source: "manual", currentBalanceCents: 5_000 },
    ]).returning();
    await db.insert(holdings).values([
      { accountId: broker.id, externalId: "gap-vti", symbol: "VTI", marketValueCents: 90_000 },
      { accountId: cashMgmt.id, externalId: "gap-spaxx", symbol: "SPAXX", marketValueCents: 2_000 },
    ]);
    const g = await getInvestmentValueGap();
    expect(g.accountValueCents - before.accountValueCents).toBe(100_000);
    expect(g.positionsCents - before.positionsCents).toBe(90_000);
    expect(g.uninvestedCents - before.uninvestedCents).toBe(10_000);
    expect(g.positionsElsewhereCents - before.positionsElsewhereCents).toBe(2_000);
    expect(g.accountValueCents).toBe(g.positionsCents + g.uninvestedCents);
    expect(g.allPositionsCents).toBe(g.positionsCents + g.positionsElsewhereCents);
  });

  test("the note names both figures and the gap", () => {
    const g = { accountValueCents: 2_624_559, positionsCents: 2_561_629, uninvestedCents: 62_930, positionsElsewhereCents: 20_099, allPositionsCents: 2_581_728 };
    expect(investmentValueGapNote(g, usd)).toBe(
      "Account value $26245.59 is positions $25616.29 plus $629.30 of uninvested cash the accounts hold outside their positions. Positions across every account (fin holdings) are $25817.28, including $200.99 held outside investment accounts.",
    );
    expect(investmentValueGapNote({ ...g, positionsElsewhereCents: 0, allPositionsCents: g.positionsCents }, usd)).not.toContain("fin holdings");
  });
});
