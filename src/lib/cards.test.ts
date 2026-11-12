import { describe, expect, test } from "bun:test";
import { db } from "@/db";
import { accounts, categories, transactions } from "@/db/schema";
import { bestCardFor, bestUses, capWindow, cardsContext, listCards, missedRewards, pctBp, rankCards, upsertCard, type CardView } from "./cards";

const q4 = { capCents: 150_000, period: "quarter" as const, capKey: "q4", from: "2026-10-01", to: "2026-12-31", activation: true };
const base = { issuer: null, accountId: null, annualFeeCents: 0, perks: null, openedOn: null, active: true, note: null, updatedAt: new Date() };
const rh: CardView = { ...base, id: 1, name: "Robinhood Gold Card", rewardCurrency: "cash", pointValue: 100, baseRateBp: 300, foreignFeeBp: null, rates: [{ category: "travel", rateBp: 500, via: "Robinhood travel portal" }] };
const cfu: CardView = { ...base, id: 2, name: "Chase Freedom Unlimited", rewardCurrency: "chase ur", pointValue: 100, baseRateBp: 150, foreignFeeBp: 300, rates: [{ category: "dining", rateBp: 300 }, { category: "drugstores", rateBp: 300 }] };
const disc: CardView = { ...base, id: 3, name: "Discover it Cash Back", rewardCurrency: "cash", pointValue: 100, baseRateBp: 100, foreignFeeBp: 0, rates: [{ category: "dining", rateBp: 500, ...q4 }, { category: "utilities", rateBp: 500, ...q4 }] };
const held = [rh, cfu, disc];

describe("card ranking (pure)", () => {
  test("rotating 5% wins only inside its quarter", () => {
    expect(rankCards(held, { cats: ["dining"], day: "2026-11-11" })[0]).toMatchObject({ name: "Discover it Cash Back", valueBp: 500 });
    expect(rankCards(held, { cats: ["dining"], day: "2027-01-02" })[0].valueBp).toBe(300);
  });

  test("a shared cap blends the rate across the boundary and then falls to base", () => {
    const capUse = new Map([["3|q4|2026-10-01", 140_000]]);
    // $10,000 left at 5%, the other $10,000 at 1% -> 3%.
    const half = rankCards(held, { cats: ["utilities"], day: "2026-11-11", amountCents: 20_000, capUse }).find((p) => p.cardId === 3)!;
    expect(half).toMatchObject({ earnBp: 300, capRemainingCents: 10_000 });
    capUse.set("3|q4|2026-10-01", 150_000);
    expect(rankCards(held, { cats: ["dining"], day: "2026-11-11", capUse })[0].name).toBe("Robinhood Gold Card");
  });

  test("abroad subtracts the foreign fee; unknown is assumed 3%", () => {
    const r = rankCards(held, { cats: ["groceries"], day: "2026-11-11", abroad: true });
    expect(r.map((p) => [p.name, p.valueBp])).toEqual([["Discover it Cash Back", 100], ["Robinhood Gold Card", 0], ["Chase Freedom Unlimited", -150]]);
    expect(r[1].warnings.join()).toContain("unknown");
  });

  test("portal-only rates are tips, never the ranked rate; points are valued", () => {
    const top = rankCards(held, { cats: ["travel"], day: "2026-11-11" })[0];
    expect(top).toMatchObject({ name: "Robinhood Gold Card", valueBp: 300 });
    expect(top.portal).toEqual([{ via: "Robinhood travel portal", rateBp: 500 }]);
    const boosted = rankCards([{ ...cfu, pointValue: 150 }], { cats: ["drugstores"], day: "2026-11-11" })[0];
    expect(boosted.valueBp).toBe(450);
  });

  test("windows and labels", () => {
    expect(capWindow({ category: "dining", rateBp: 500, period: "quarter" }, "2026-11-11")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(capWindow({ category: "dining", rateBp: 500, period: "month", from: "2026-10-15" }, "2026-10-20")).toEqual({ start: "2026-10-15", end: "2026-10-31" });
    expect([pctBp(300), pctBp(150), pctBp(125), pctBp(-150)]).toEqual(["3%", "1.5%", "1.25%", "-1.5%"]);
    const uses = bestUses(held, "2026-11-11");
    expect(uses.get(3)).toEqual(["dining", "utilities"]);
    expect(uses.get(1)).toContain("everything else");
  });
});

describe("cards store and ledger", () => {
  test("upsert by name, validation, missed rewards and context", async () => {
    await expect(upsertCard({ name: "Bad", categoryRates: [{ category: "dining", rateBp: -1 }] as never })).rejects.toThrow();
    const cat = async (name: string) => (await db.insert(categories).values({ name, kind: "expense" }).returning())[0].id;
    const restaurants = await cat("Restaurants");
    const electronics = await cat("Electronics");
    const [chase] = await db.insert(accounts).values({ name: "Chase FU test", type: "credit", isAsset: false }).returning();
    const [rhAcct] = await db.insert(accounts).values({ name: "RH test", type: "credit", isAsset: false }).returning();
    const first = await upsertCard({ name: "Chase Freedom Unlimited", accountId: chase.id, rewardCurrency: "Chase UR", baseRateBp: 150, categoryRates: cfu.rates, foreignFeeBp: 300 });
    const again = await upsertCard({ name: "Chase Freedom Unlimited", note: "x" });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ baseRateBp: 150, rewardCurrency: "chase ur", accountId: chase.id, note: "x" });
    await upsertCard({ name: "Robinhood Gold Card", accountId: rhAcct.id, baseRateBp: 300, annualFeeCents: 5_000 });
    await upsertCard({ name: "Discover it Cash Back", baseRateBp: 100, foreignFeeBp: 0, categoryRates: disc.rates });
    expect((await listCards()).map((c) => c.name)).toHaveLength(3);

    const at = (d: string) => new Date(`${d}T12:00:00`);
    await db.insert(transactions).values([
      { accountId: chase.id, postedAt: at("2026-09-10"), amountCents: -10_000, payeeNormalized: "rei", categoryId: electronics },
      { accountId: chase.id, postedAt: at("2026-11-02"), amountCents: -4_000, payeeNormalized: "pho", categoryId: restaurants },
      { accountId: chase.id, postedAt: at("2026-11-03"), amountCents: -9_999, payeeNormalized: "transfer", isTransfer: true },
      { accountId: rhAcct.id, postedAt: at("2026-11-04"), amountCents: -5_000, payeeNormalized: "pending", isPending: true },
      { accountId: rhAcct.id, postedAt: at("2026-11-05"), amountCents: 2_000, payeeNormalized: "refund" },
    ]);
    const m = await missedRewards({ from: "2026-09-01", to: "2026-11-30" });
    // REI: 1.5% earned, 3% possible on Robinhood. Pho: 3% earned; Discover's 5% would need it unlinked-but-held, which counts.
    expect(m.totals).toEqual({ spendCents: 14_000, earnedCents: 270, bestCents: 500, missedCents: 230 });
    expect(m.topMerchants[0]).toMatchObject({ merchant: "rei", usedCard: "Chase Freedom Unlimited", bestCard: "Robinhood Gold Card", missedCents: 150 });
    expect(m.unlinkedCards).toEqual(["Discover it Cash Back"]);

    const pick = await bestCardFor({ category: "pho", date: "2026-11-11" });
    expect(pick.query).toMatchObject({ matchedBy: "merchant", finCategory: "Restaurants", cats: ["dining"] });
    expect(pick.ranked[0].name).toBe("Discover it Cash Back");
    expect((await bestCardFor({ category: "groceries" })).query.matchedBy).toBe("card category");

    const ctx = await cardsContext("2026-11-11");
    expect(ctx.text).toContain("Robinhood Gold Card [RH test]: 3% base");
    expect(ctx.cards.find((c) => c.name === "Discover it Cash Back")!.useFor).toContain("dining");
  });
});
