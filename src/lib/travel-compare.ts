/**
 * The three ways to pay for one hotel booking, as net cost after what each
 * earns back. Pure (no database), so the /travel calculator and
 * `fin points-vs-cash --hotel` run the same arithmetic.
 *
 *   points  — redeem card points in the portal. Costs the points' value
 *             elsewhere; earns nothing.
 *   portal  — pay cash in the portal on the card that earns the portal rate
 *             (Freedom Unlimited: 5x in Chase Travel). No hotel points, no
 *             elite nights.
 *   direct  — book with the hotel at its own price, earn the hotel program's
 *             points (and elite nights), and pay with the best card for travel.
 */
import { brandFor } from "@/lib/travel-brands";
import { defaultValuation } from "@/lib/travel-advisor";

export type CompareInput = {
  /** Portal cash price. */
  cashCents: number;
  /** Portal points price. */
  points: number;
  /** Value of one card point elsewhere, hundredths of a cent (Chase Freedom-only: 100). */
  pointValueHundredthsCpp: number;
  /** Portal earn on the portal card, basis points of spend at the point value above (Freedom Unlimited in Chase Travel: 500). */
  portalEarnBp: number;
  portalCard: string;
  /** Direct price; defaults to the portal cash price. */
  directCashCents?: number;
  /** Hotel program name, e.g. "Wyndham Rewards". */
  hotel: string;
  /** Hotel point value, hundredths of a cent; defaults to the dated estimate. */
  hotelValueHundredthsCpp?: number;
  /** Best card for a direct travel booking and its cash-equivalent rate (basis points). */
  directCard: string;
  directCardBp: number;
  /** Number of stays the booking counts as (the per-stay minimum applies per stay). */
  stays?: number;
};

export type Option = {
  key: "points" | "portal" | "direct";
  label: string;
  /** What leaves your pocket: dollars, or the points' cash value. */
  outlayCents: number;
  /** What comes back, valued in cents. */
  backCents: number;
  netCents: number;
  lines: string[];
};

export type CompareResult = { options: Option[]; winner: Option; marginCents: number; hotelPoints: number; hotelValueHundredthsCpp: number; note: string };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const cpp = (h: number) => `${(h / 100).toFixed(2)}c`;
const pctBp = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`;

export function hotelEarn(hotel: string, cashCents: number, stays = 1): number {
  const b = brandFor(hotel);
  const per = b.earnPerDollar ?? 0;
  const base = Math.floor((cashCents / 100) * per);
  return b.minPerStay ? Math.max(base, b.minPerStay * stays) : base;
}

export function compareBooking(i: CompareInput): CompareResult {
  if (!(i.cashCents > 0) || !(i.points > 0)) throw new Error("cash and points must both be positive");
  const direct = i.directCashCents && i.directCashCents > 0 ? i.directCashCents : i.cashCents;
  const hotelValue = i.hotelValueHundredthsCpp ?? defaultValuation(i.hotel)?.hundredthsCpp ?? 0;
  const pointsCost = Math.round((i.points * i.pointValueHundredthsCpp) / 100);
  const portalBack = Math.round((i.cashCents * i.portalEarnBp) / 10_000);
  const hotelPoints = hotelEarn(i.hotel, direct, i.stays);
  const hotelBack = Math.round((hotelPoints * hotelValue) / 100);
  const cardBack = Math.round((direct * i.directCardBp) / 10_000);
  const options: Option[] = [
    {
      key: "points", label: "Points in the portal", outlayCents: pointsCost, backCents: 0, netCents: pointsCost,
      lines: [`${i.points.toLocaleString("en-US")} pts × ${cpp(i.pointValueHundredthsCpp)} = ${usd(pointsCost)} of points`, `${cpp(Math.round((i.cashCents * 100) / i.points))} per point achieved`, "No hotel points or elite nights"],
    },
    {
      key: "portal", label: `Cash in the portal on ${i.portalCard}`, outlayCents: i.cashCents, backCents: portalBack, netCents: i.cashCents - portalBack,
      lines: [`${usd(i.cashCents)} cash`, `− ${usd(portalBack)} back (${pctBp(i.portalEarnBp)} portal earn)`, "No hotel points or elite nights"],
    },
    {
      key: "direct", label: `Book direct, pay with ${i.directCard}`, outlayCents: direct, backCents: cardBack + hotelBack, netCents: direct - cardBack - hotelBack,
      lines: [
        `${usd(direct)} cash`,
        `− ${usd(cardBack)} card back (${pctBp(i.directCardBp)})`,
        hotelValue
          ? `− ${usd(hotelBack)} of ${brandFor(i.hotel).key === "other" ? "hotel" : i.hotel} points (${hotelPoints.toLocaleString("en-US")} × ${cpp(hotelValue)})`
          : `${i.hotel}: no point value known, counted as $0`,
        "Earns elite nights",
      ],
    },
  ];
  const sorted = options.toSorted((a, b) => a.netCents - b.netCents);
  const winner = sorted[0];
  const marginCents = sorted[1].netCents - winner.netCents;
  const note = marginCents < Math.round(i.cashCents * 0.02)
    ? `Within ${usd(marginCents)}: close enough that flexibility (refundable rate, elite nights) should decide.`
    : `${winner.label} saves ${usd(marginCents)} over the next best.`;
  return { options, winner, marginCents, hotelPoints, hotelValueHundredthsCpp: hotelValue, note };
}
