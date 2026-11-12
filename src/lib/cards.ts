import "server-only";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { format } from "date-fns";
import { z } from "zod";
import { db } from "@/db";
import { accounts, categories, creditCards, transactions } from "@/db/schema";

/**
 * Credit cards: what each earns where, and which one to reach for.
 * Rates are basis points (300 = 3%). A points card's rate is points per
 * dollar x 100; its cash value comes from CURRENCY_VALUE below.
 */

export const CARD_CATEGORIES = ["dining", "groceries", "gas", "drugstores", "travel", "transit", "entertainment", "utilities", "streaming"] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];

/**
 * fin category name -> the card categories issuers would code it as. A
 * category not listed falls back to its parent; anything else earns base.
 */
export const FIN_TO_CARD: Record<string, CardCategory[]> = {
  "Food & Dining": ["dining"], Restaurants: ["dining"], "Coffee Shops": ["dining"], "Fast Food": ["dining"],
  Groceries: ["groceries"],
  Gas: ["gas"],
  Pharmacy: ["drugstores"],
  Travel: ["travel"],
  Rideshare: ["transit"], "Public Transit": ["transit"], Parking: ["transit"],
  Entertainment: ["entertainment"],
  Streaming: ["streaming"],
  "Bills & Utilities": ["utilities"], "Home Utilities": ["utilities"], "Electric & Gas": ["utilities"], Phone: ["utilities"], Internet: ["utilities"],
};

/** Cash value of one unit of each reward currency, hundredths of a cent. Unknown currencies count at 1.00c. */
export const CURRENCY_VALUE: Record<string, number> = { cash: 100, "chase ur": 100 };
/** Ranking assumes this foreign fee when a card's is unknown, so an unverified card never wins abroad by accident. */
export const ASSUMED_FX_BP = 300;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v === undefined ? undefined : v || null));

export const categoryRate = z.object({
  category: z.enum(CARD_CATEGORIES),
  rateBp: z.number().int().min(0).max(5_000),
  /** Spend that earns the bonus per period; beyond it, base rate. */
  capCents: z.number().int().positive().optional(),
  period: z.enum(["month", "quarter", "year"]).optional(),
  /** Rates sharing a capKey share one cap (Discover's $1,500 covers all three quarterly categories). */
  capKey: z.string().max(40).optional(),
  /** Rotating categories: only active inside these dates. */
  from: isoDay.optional(),
  to: isoDay.optional(),
  /** Only when booked through this portal; shown as a tip, never assumed. */
  via: z.string().max(60).optional(),
  activation: z.boolean().optional(),
  note: z.string().max(200).optional(),
}).strict();
export type CategoryRate = z.infer<typeof categoryRate>;

const cardInput = z.object({
  name: z.string().trim().min(1).max(80),
  issuer: optText(60),
  accountId: z.number().int().positive().nullish(),
  rewardCurrency: z.string().trim().toLowerCase().min(1).max(30).optional(),
  baseRateBp: z.number().int().min(0).max(5_000).optional(),
  categoryRates: z.array(categoryRate).max(40).optional(),
  annualFeeCents: z.number().int().min(0).max(1_000_000).optional(),
  foreignFeeBp: z.number().int().min(0).max(1_000).nullish(),
  perks: optText(500),
  openedOn: isoDay.nullish(),
  active: z.boolean().optional(),
  note: optText(1_000),
}).strict();
export type CardInput = z.input<typeof cardInput>;

export function parseRates(json: string): CategoryRate[] {
  return z.array(categoryRate).parse(JSON.parse(json));
}

function toRow(c: Partial<z.output<typeof cardInput>>) {
  const { categoryRates, ...rest } = c;
  const row = { ...rest, ...(categoryRates ? { categoryRatesJson: JSON.stringify(categoryRates) } : {}) };
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as Partial<typeof creditCards.$inferInsert>;
}

/** Insert or update by the unique card name; omitted fields keep what is stored. */
export async function upsertCard(input: CardInput) {
  const c = cardInput.parse(input);
  const row = toRow(c);
  const [saved] = await db.insert(creditCards).values({ ...row, name: c.name })
    .onConflictDoUpdate({ target: creditCards.name, set: { ...row, updatedAt: new Date() } }).returning();
  return view(saved);
}

export async function updateCard(id: number, patch: Partial<CardInput>) {
  const [row] = await db.update(creditCards).set({ ...toRow(cardInput.partial().parse(patch)), updatedAt: new Date() }).where(eq(creditCards.id, id)).returning();
  if (!row) throw new Error(`no card #${id}`);
  return view(row);
}

export async function deleteCard(id: number) {
  await db.delete(creditCards).where(eq(creditCards.id, id));
}

export type CardView = Omit<typeof creditCards.$inferSelect, "categoryRatesJson"> & { rates: CategoryRate[]; pointValue: number };

function view(r: typeof creditCards.$inferSelect): CardView {
  const { categoryRatesJson, ...rest } = r;
  return { ...rest, rates: parseRates(categoryRatesJson), pointValue: CURRENCY_VALUE[r.rewardCurrency] ?? 100 };
}

export async function listCards(opts: { activeOnly?: boolean } = {}): Promise<CardView[]> {
  const rows = await db.select().from(creditCards).where(opts.activeOnly ? eq(creditCards.active, true) : undefined).orderBy(asc(creditCards.name));
  return rows.map(view);
}

export async function findCard(name: string) {
  const cards = await listCards();
  const lower = name.toLowerCase();
  return cards.find((c) => c.name.toLowerCase() === lower) ?? cards.find((c) => c.name.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------- pure math

/** The cap window containing `day`, clipped to the rate's own dates. */
export function capWindow(rate: CategoryRate, day: string): { start: string; end: string } {
  const [y, m] = day.split("-").map(Number);
  const startMonth = rate.period === "month" ? m : rate.period === "quarter" ? m - ((m - 1) % 3) : 1;
  const months = rate.period === "month" ? 1 : rate.period === "quarter" ? 3 : 12;
  const start = format(new Date(y, startMonth - 1, 1), "yyyy-MM-dd");
  const end = format(new Date(y, startMonth - 1 + months, 0), "yyyy-MM-dd");
  return { start: rate.from && rate.from > start ? rate.from : start, end: rate.to && rate.to < end ? rate.to : end };
}

const activeOn = (r: CategoryRate, day: string) => (!r.from || r.from <= day) && (!r.to || day <= r.to);
const capKeyOf = (r: CategoryRate) => r.capKey ?? r.category;

/** The bonus rate a purchase in these categories would get on this card that day, ignoring portal-only rates. */
export function bonusRate(card: CardView, cats: readonly CardCategory[], day: string): CategoryRate | undefined {
  return card.rates
    .filter((r) => !r.via && cats.includes(r.category) && activeOn(r, day) && r.rateBp > card.baseRateBp)
    .sort((a, b) => b.rateBp - a.rateBp)[0];
}

/** Bonus spend already used in a cap window, keyed by `${cardId}|${capKey}|${windowStart}`. */
export type CapUse = Map<string, number>;
export const capUseKey = (cardId: number, r: CategoryRate, day: string) => `${cardId}|${capKeyOf(r)}|${capWindow(r, day).start}`;

export type Pick = {
  cardId: number;
  name: string;
  /** Earn rate actually applied (blended across a cap boundary), bp. */
  earnBp: number;
  /** Cash value after point value and any foreign fee, bp. What the ranking sorts on. */
  valueBp: number;
  why: string;
  capRemainingCents?: number;
  /** Portal-only bonuses for these categories, offered as tips. */
  portal: { via: string; rateBp: number; note?: string }[];
  warnings: string[];
};

export type RankInput = { cats: readonly CardCategory[]; day: string; abroad?: boolean; amountCents?: number; capUse?: CapUse };

export function scoreCard(card: CardView, o: RankInput): Pick {
  const warnings: string[] = [];
  const bonus = bonusRate(card, o.cats, o.day);
  let earnBp = card.baseRateBp;
  let why = `${pctBp(card.baseRateBp)} base`;
  let capRemainingCents: number | undefined;
  if (bonus) {
    why = `${pctBp(bonus.rateBp)} ${bonus.category}${bonus.to ? ` through ${bonus.to}` : ""}`;
    earnBp = bonus.rateBp;
    if (bonus.capCents) {
      capRemainingCents = Math.max(0, bonus.capCents - (o.capUse?.get(capUseKey(card.id, bonus, o.day)) ?? 0));
      if (o.amountCents && o.amountCents > capRemainingCents) {
        earnBp = Math.round((capRemainingCents * bonus.rateBp + (o.amountCents - capRemainingCents) * card.baseRateBp) / o.amountCents);
        why += `, only ${formatCents(capRemainingCents)} of the ${formatCents(bonus.capCents)} cap left`;
      } else if (!o.amountCents && capRemainingCents === 0) {
        earnBp = card.baseRateBp;
        why = `${formatCents(bonus.capCents)} ${bonus.category} cap used up; ${pctBp(card.baseRateBp)} base`;
      }
    }
    if (bonus.activation) warnings.push("needs quarterly activation");
    if (bonus.note && /verify/i.test(bonus.note)) warnings.push(bonus.note);
  }
  let valueBp = Math.round((earnBp * card.pointValue) / 100);
  if (card.pointValue !== 100) why += ` (${card.rewardCurrency} at ${(card.pointValue / 100).toFixed(2)}c)`;
  if (o.abroad) {
    const fx = card.foreignFeeBp ?? ASSUMED_FX_BP;
    if (card.foreignFeeBp == null) warnings.push(`foreign fee unknown; assumed ${pctBp(ASSUMED_FX_BP)}`);
    if (fx) why += `, minus ${pctBp(fx)} foreign fee`;
    valueBp -= fx;
  }
  const portal = card.rates.filter((r) => r.via && o.cats.includes(r.category) && activeOn(r, o.day))
    .map((r) => ({ via: r.via!, rateBp: r.rateBp, ...(r.note ? { note: r.note } : {}) }));
  return { cardId: card.id, name: card.name, earnBp, valueBp, why, ...(capRemainingCents !== undefined ? { capRemainingCents } : {}), portal, warnings };
}

/** Best first; ties go to the card with fewer caveats, then to cash over points. */
export function rankCards(cards: CardView[], o: RankInput): Pick[] {
  const isCash = new Map(cards.map((c) => [c.id, c.rewardCurrency === "cash" ? 0 : 1]));
  return cards.filter((c) => c.active).map((c) => scoreCard(c, o))
    .sort((a, b) => b.valueBp - a.valueBp || a.warnings.length - b.warnings.length || isCash.get(a.cardId)! - isCash.get(b.cardId)! || a.name.localeCompare(b.name));
}

/** Which card wins each card category today, plus "everything else". Drives the "use it for" chips. */
export function bestUses(cards: CardView[], day: string): Map<number, string[]> {
  const out = new Map<number, string[]>(cards.map((c) => [c.id, []]));
  for (const cat of [...CARD_CATEGORIES, null]) {
    const top = rankCards(cards, { cats: cat ? [cat] : [], day })[0];
    if (top) out.get(top.cardId)!.push(cat ?? "everything else");
  }
  return out;
}

export function cardCategoriesFor(finName: string | null, parentName?: string | null): CardCategory[] {
  if (!finName) return [];
  return FIN_TO_CARD[finName] ?? (parentName ? FIN_TO_CARD[parentName] ?? [] : []);
}

export const pctBp = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? (bp % 10 ? 2 : 1) : 0)}%`;
const formatCents = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

