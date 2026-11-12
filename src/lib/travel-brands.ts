/**
 * Brand marks for loyalty programs and card issuers: a colour pair and a short
 * monogram the UI draws locally (no hotlinked logos), plus the merchant text
 * that finds the brand's charges in the ledger. Pure, client-safe.
 */
export type Brand = {
  key: string;
  /** Monogram shown on the tile. */
  mark: string;
  bg: string;
  fg: string;
  /** Lower-case substrings of a ledger description that belong to this brand. */
  merchants: string[];
  /** Hotel points earned per dollar booked direct, and the per-stay floor (Wyndham: 1,000). */
  earnPerDollar?: number;
  minPerStay?: number;
};

const BRANDS: (Brand & { match: RegExp })[] = [
  { key: "alaska", match: /alaska|hawaiian|atmos/i, mark: "AS", bg: "#01426a", fg: "#ffffff", merchants: ["alaska air", "alaskaair", "hawaiian air", "hawaiianair"] },
  { key: "united", match: /united|mileageplus/i, mark: "UA", bg: "#0a2a66", fg: "#ffffff", merchants: ["united air", "united.com", "united 0"] },
  { key: "delta", match: /delta|skymiles/i, mark: "DL", bg: "#9b1631", fg: "#ffffff", merchants: ["delta air", "delta.com"] },
  { key: "southwest", match: /southwest/i, mark: "WN", bg: "#304cb2", fg: "#ffbf27", merchants: ["southwest"] },
  { key: "aircanada", match: /air canada|aeroplan/i, mark: "AC", bg: "#d22630", fg: "#ffffff", merchants: ["air canada", "aircanada"] },
  { key: "marriott", match: /marriott|bonvoy/i, mark: "M", bg: "#1c1c1c", fg: "#f2a900", merchants: ["marriott", "bonvoy", "sheraton", "westin", "courtyard"], earnPerDollar: 10 },
  { key: "hyatt", match: /hyatt|andaz/i, mark: "H", bg: "#0a3a5c", fg: "#ffffff", merchants: ["hyatt", "andaz"], earnPerDollar: 5 },
  { key: "wyndham", match: /wyndham|days inn|la quinta|super 8|ramada/i, mark: "W", bg: "#0068b3", fg: "#ffffff", merchants: ["wyndham", "days inn", "la quinta", "super 8", "ramada"], earnPerDollar: 10, minPerStay: 1000 },
  { key: "ihg", match: /ihg|holiday inn/i, mark: "IHG", bg: "#e8562a", fg: "#ffffff", merchants: ["ihg", "holiday inn", "crowne plaza"], earnPerDollar: 10 },
  { key: "hilton", match: /hilton/i, mark: "H", bg: "#104c97", fg: "#ffffff", merchants: ["hilton", "hampton inn"], earnPerDollar: 10 },
  { key: "choice", match: /choice/i, mark: "C", bg: "#00467f", fg: "#ffffff", merchants: ["comfort inn", "quality inn", "choice hotels"], earnPerDollar: 10 },
  { key: "booking", match: /booking\.com|genius/i, mark: "B.", bg: "#003580", fg: "#ffffff", merchants: ["booking.com", "booking com"] },
  { key: "bilt", match: /bilt/i, mark: "bilt", bg: "#000000", fg: "#ffffff", merchants: ["bilt"] },
  { key: "chase", match: /chase|ultimate rewards|freedom|sapphire/i, mark: "UR", bg: "#124a9a", fg: "#ffffff", merchants: ["chase travel"] },
  { key: "robinhood", match: /robinhood/i, mark: "RH", bg: "#111111", fg: "#d6b85a", merchants: ["robinhood"] },
  { key: "discover", match: /discover/i, mark: "D", bg: "#ff6000", fg: "#ffffff", merchants: ["discover"] },
];

const FALLBACK = (name: string): Brand => ({
  key: "other",
  mark: name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?",
  bg: "var(--muted)",
  fg: "var(--muted-foreground)",
  merchants: [],
});

export function brandFor(name: string): Brand {
  const hit = BRANDS.find((b) => b.match.test(name));
  if (!hit) return FALLBACK(name);
  return { key: hit.key, mark: hit.mark, bg: hit.bg, fg: hit.fg, merchants: hit.merchants, earnPerDollar: hit.earnPerDollar, minPerStay: hit.minPerStay };
}

/**
 * Card faces: issuer colours as a CSS gradient. Unknown issuers get a neutral
 * graphite face so the card still reads as a card.
 */
export function cardFace(name: string, issuer: string | null): { background: string; fg: string; accent: string } {
  const s = `${name} ${issuer ?? ""}`;
  if (/robinhood/i.test(s)) return { background: "linear-gradient(135deg,#2a2618 0%,#0d0d0d 55%,#1f1a0e 100%)", fg: "#f3e2a8", accent: "#d6b85a" };
  if (/freedom/i.test(s)) return { background: "linear-gradient(135deg,#1b5fc1 0%,#0f3f8c 60%,#0a2c66 100%)", fg: "#ffffff", accent: "#9cc4ff" };
  if (/sapphire/i.test(s)) return { background: "linear-gradient(135deg,#123a7a 0%,#0b1f45 100%)", fg: "#ffffff", accent: "#8fb0e8" };
  if (/discover/i.test(s)) return { background: "linear-gradient(135deg,#ff7a1a 0%,#f05a00 55%,#d24a00 100%)", fg: "#ffffff", accent: "#ffe2c8" };
  if (/chase/i.test(s)) return { background: "linear-gradient(135deg,#1a56b0 0%,#0d2f6b 100%)", fg: "#ffffff", accent: "#9cc4ff" };
  return { background: "linear-gradient(135deg,#3b3f47 0%,#1d1f24 100%)", fg: "#ffffff", accent: "#c7cbd3" };
}

/** "Robinhood Credit Card **7531 (7531)" → "7531". */
export const lastFour = (accountName: string | null | undefined) => accountName?.match(/(\d{4})\)?\s*$/)?.[1] ?? null;
