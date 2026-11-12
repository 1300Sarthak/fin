/**
 * Pure booking math: no database, safe to import from client components.
 * Point values are in hundredths of a cent (110 = 1.10 cents per point).
 */

export const VALUATIONS_AS_OF = "2026-11";

export type ProgramKind = "card" | "airline" | "hotel" | "other";
export type Valuation = { name: string; kind: ProgramKind; hundredthsCpp: number; match: RegExp; note?: string };

/**
 * Default values, editable per program on /travel. Estimates as of 2026-11,
 * roughly the midpoint of published valuations (The Points Guy, NerdWallet);
 * not quotes. Redemption value varies by booking, so treat each as a floor
 * to beat, not a promise.
 */
export const DEFAULT_VALUATIONS: Valuation[] = [
  { name: "Chase Ultimate Rewards (Freedom only)", kind: "card", hundredthsCpp: 100, match: /chase|ultimate rewards|\bur\b/i, note: "Chase Travel or cash back at 1.0c; Points Boost hotels up to ~1.1c" },
  { name: "Chase Ultimate Rewards (with Sapphire)", kind: "card", hundredthsCpp: 170, match: /sapphire/i, note: "transfers to Hyatt/United etc.; ~1.5-2.0c" },
  { name: "Capital One miles", kind: "card", hundredthsCpp: 170, match: /capital one|venture/i, note: "transfer partners; 1.0c as travel eraser" },
  { name: "Amex Membership Rewards", kind: "card", hundredthsCpp: 170, match: /amex|american express|membership rewards/i },
  { name: "World of Hyatt", kind: "hotel", hundredthsCpp: 170, match: /hyatt/i },
  { name: "Wyndham Rewards", kind: "hotel", hundredthsCpp: 90, match: /wyndham|la quinta/i, note: "La Quinta is Wyndham" },
  { name: "Hilton Honors", kind: "hotel", hundredthsCpp: 50, match: /hilton/i },
  { name: "Marriott Bonvoy", kind: "hotel", hundredthsCpp: 80, match: /marriott|bonvoy/i },
  { name: "IHG One Rewards", kind: "hotel", hundredthsCpp: 55, match: /ihg|holiday inn/i },
  { name: "Choice Privileges", kind: "hotel", hundredthsCpp: 60, match: /choice/i },
  { name: "Southwest Rapid Rewards", kind: "airline", hundredthsCpp: 130, match: /southwest/i },
  { name: "United MileagePlus", kind: "airline", hundredthsCpp: 120, match: /united|mileageplus/i },
  { name: "Delta SkyMiles", kind: "airline", hundredthsCpp: 115, match: /delta|skymiles/i },
  { name: "Alaska Mileage Plan / Atmos", kind: "airline", hundredthsCpp: 130, match: /alaska|atmos/i },
  { name: "American AAdvantage", kind: "airline", hundredthsCpp: 140, match: /american|aadvantage/i },
];

/** First default whose pattern matches a program name; "sapphire" wins over plain Chase. */
export function defaultValuation(name: string): Valuation | undefined {
  return DEFAULT_VALUATIONS.find((v) => v.match.test(name) && /sapphire/i.test(name) === /sapphire/i.test(v.name))
    ?? DEFAULT_VALUATIONS.find((v) => v.match.test(name));
}

export type PointsVsCashInput = {
  cashCents: number;
  points: number;
  /** What one point is worth to you elsewhere (hundredths of a cent). */
  programValueHundredthsCpp: number;
  /** Cash rate is refundable and the points rate is not. */
  refundableCash?: boolean;
  /** Booking direct with cash earns hotel/airline points and elite credit; the portal booking does not. */
  earnsLoyaltyIfDirect?: boolean;
  /** Card cash back on the cash option, basis points (Robinhood Gold = 300). */
  cardBackBps?: number;
  /** Loyalty earning on a direct booking, basis points of cash. Default 5%. */
  loyaltyBps?: number;
};

export type Verdict = "use points" | "pay cash" | "roughly equal";
export type PointsVsCashResult = {
  achievedHundredthsCpp: number;
  pointsCostCents: number;
  effectiveCashCents: number;
  cardBackCents: number;
  loyaltyCents: number;
  verdict: Verdict;
  reason: string;
};

const cpp = (h: number) => (h / 100).toFixed(2) + "c";
const usd = (c: number) => "$" + (c / 100).toFixed(2);

/**
 * Compare the points' opportunity cost (points x their value) against the
 * cash price net of card cash back and, when booking direct earns it, the
 * loyalty value given up by redeeming through a portal.
 */
export function pointsVsCash(i: PointsVsCashInput): PointsVsCashResult {
  if (!(i.cashCents > 0) || !(i.points > 0)) throw new Error("cash and points must both be positive");
  const achievedHundredthsCpp = Math.round((i.cashCents * 100) / i.points);
  const pointsCostCents = Math.round((i.points * i.programValueHundredthsCpp) / 100);
  const cardBackCents = Math.round((i.cashCents * (i.cardBackBps ?? 300)) / 10_000);
  const loyaltyCents = i.earnsLoyaltyIfDirect ? Math.round((i.cashCents * (i.loyaltyBps ?? 500)) / 10_000) : 0;
  const effectiveCashCents = i.cashCents - cardBackCents - loyaltyCents;
  // Points must win by a margin; more when they also cost refundability.
  const margin = Math.round(i.cashCents * (i.refundableCash ? 0.1 : 0.03));
  const diff = effectiveCashCents - pointsCostCents;
  const verdict: Verdict = diff > margin ? "use points" : diff < -Math.round(i.cashCents * 0.03) ? "pay cash" : "roughly equal";
  const parts = [
    `${cpp(achievedHundredthsCpp)}/pt vs ${cpp(i.programValueHundredthsCpp)} value`,
    `points cost ${usd(pointsCostCents)}; cash nets ${usd(effectiveCashCents)} after ${usd(cardBackCents)} card back`,
  ];
  if (loyaltyCents) parts.push(`and ${usd(loyaltyCents)} of loyalty earning a portal booking forfeits`);
  if (i.refundableCash) parts.push("cash rate is refundable, so points need a 10% edge");
  return { achievedHundredthsCpp, pointsCostCents, effectiveCashCents, cardBackCents, loyaltyCents, verdict, reason: parts.join("; ") };
}

export type HeldProgram = { name: string; kind: ProgramKind; valueCentsPerPoint?: number | null };
type TipContext = { held: HeldProgram[]; trip: "hotel" | "flight"; abroad: boolean };
type Rule = { when: (c: TipContext) => boolean; tip: (c: TipContext) => string };

const ofKind = (c: TipContext, k: ProgramKind) => c.held.filter((p) => p.kind === k).map((p) => p.name);
const transferable = (c: TipContext) => c.held.some((p) => /sapphire|ink|capital one|venture/i.test(p.name));

const RULES: Rule[] = [
  { when: (c) => c.trip === "hotel" && ofKind(c, "hotel").length > 0, tip: (c) => `If the brand is ${ofKind(c, "hotel").join(" / ")}, book direct: portals earn no hotel points or elite nights.` },
  { when: (c) => c.trip === "hotel" && ofKind(c, "hotel").length === 0, tip: () => "Join the hotel's free program and book direct; portal and OTA stays earn no hotel points or elite nights." },
  { when: (c) => c.trip === "flight" && ofKind(c, "airline").length > 0, tip: (c) => `Add your ${ofKind(c, "airline").join(" / ")} number to the reservation; portal-booked flights still earn miles.` },
  { when: (c) => c.held.some((p) => /chase|ultimate/i.test(p.name)) && !transferable(c), tip: () => "Freedom-only Chase points are worth 1.0c; redeem in Chase Travel only above that (Points Boost), else hold them." },
  { when: (c) => !c.abroad, tip: () => "Pay cash bookings with Robinhood Gold (3% back)." },
  { when: (c) => c.abroad, tip: () => "Abroad: Robinhood Gold likely adds a ~3% FX fee; use a no-FX card (Discover it has none, but acceptance is spotty)." },
  { when: (c) => !transferable(c), tip: () => "Long term: a transferable-points card (Sapphire Preferred if under 5/24, else Venture X) lifts point value toward ~1.7c via partners like Hyatt." },
];

/** A short, rule-driven list of what to do for this booking. */
export function bookingTips(held: HeldProgram[], trip: "hotel" | "flight", opts: { abroad?: boolean } = {}): string[] {
  const c: TipContext = { held, trip, abroad: opts.abroad ?? false };
  return RULES.filter((r) => r.when(c)).map((r) => r.tip(c));
}
