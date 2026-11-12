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

// ------------------------------------------------------------- ledger reads

const today = () => format(new Date(), "yyyy-MM-dd");

async function categoryIndex() {
  const rows = await db.select({ id: categories.id, name: categories.name, kind: categories.kind, parentId: categories.parentId }).from(categories);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => ({ ...r, cats: cardCategoriesFor(r.name, r.parentId ? byId.get(r.parentId)?.name : null) }));
}

/**
 * Card spend: outflows on accounts linked to a card that a rewards program would
 * pay on. Transfers, payments, excluded and pending rows, interest and fees are not purchases.
 */
async function cardSpend(accountIds: number[], startDay: string, endDay: string) {
  if (!accountIds.length) return [];
  const start = new Date(`${startDay}T00:00:00`);
  const end = new Date(`${endDay}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const rows = await db.select({
    id: transactions.id, accountId: transactions.accountId, postedAt: transactions.postedAt, amountCents: transactions.amountCents,
    merchant: sql<string>`coalesce(nullif(${transactions.payeeNormalized}, ''), ${transactions.merchantRaw})`,
    categoryName: categories.name, categoryKind: categories.kind, categoryId: transactions.categoryId,
  }).from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(
      inArray(transactions.accountId, accountIds),
      gte(transactions.postedAt, start), lt(transactions.postedAt, end), lt(transactions.amountCents, 0),
      eq(transactions.isTransfer, false), eq(transactions.isExcluded, false), eq(transactions.isPending, false),
    ))
    .orderBy(asc(transactions.postedAt), asc(transactions.id));
  return rows.filter((r) => !["transfer", "investment", "income"].includes(r.categoryKind ?? "expense") && r.categoryName !== "Fees & Charges")
    .map((r) => ({ ...r, day: format(r.postedAt, "yyyy-MM-dd"), spendCents: -r.amountCents }));
}

/** Bonus spend each card has already used in the cap windows that contain `day`. */
async function capUseOn(cards: CardView[], day: string): Promise<CapUse> {
  const use: CapUse = new Map();
  const capped = cards.filter((c) => c.accountId && c.rates.some((r) => r.capCents));
  if (!capped.length) return use;
  const index = new Map((await categoryIndex()).map((c) => [c.id, c.cats]));
  const yearStart = `${day.slice(0, 4)}-01-01`;
  const spend = await cardSpend(capped.map((c) => c.accountId!), yearStart, day);
  for (const card of capped) {
    for (const t of spend.filter((s) => s.accountId === card.accountId)) {
      const bonus = bonusRate(card, (t.categoryId && index.get(t.categoryId)) || [], t.day);
      if (!bonus?.capCents || capWindow(bonus, t.day).start !== capWindow(bonus, day).start) continue;
      const key = capUseKey(card.id, bonus, day);
      use.set(key, (use.get(key) ?? 0) + t.spendCents);
    }
  }
  return use;
}

export type Resolved = { input: string; matchedBy: "fin category" | "card category" | "merchant" | "none"; finCategory: string | null; cats: CardCategory[] };

/** A fin category, a card category ("dining"), or a merchant seen in the ledger, in that order. */
export async function resolveQuery(q: { category?: string; merchant?: string }): Promise<Resolved> {
  const index = await categoryIndex();
  const text = (q.category ?? q.merchant ?? "").trim();
  const lower = text.toLowerCase();
  if (q.category) {
    const fin = index.find((c) => c.name.toLowerCase() === lower);
    if (fin) return { input: text, matchedBy: "fin category", finCategory: fin.name, cats: fin.cats };
    const card = CARD_CATEGORIES.find((c) => c === lower || c === `${lower}s`);
    if (card) return { input: text, matchedBy: "card category", finCategory: null, cats: [card] };
  }
  if (text) {
    const like = `%${lower.replace(/[%_]/g, "")}%`;
    const [top] = await db.select({ categoryId: transactions.categoryId, n: sql<number>`count(*)` }).from(transactions)
      .where(and(sql`${transactions.categoryId} is not null`, sql`(lower(${transactions.payeeNormalized}) like ${like} or lower(${transactions.merchantRaw}) like ${like})`, lt(transactions.amountCents, 0)))
      .groupBy(transactions.categoryId).orderBy(sql`count(*) desc`).limit(1);
    const fin = top && index.find((c) => c.id === top.categoryId);
    if (fin) return { input: text, matchedBy: "merchant", finCategory: fin.name, cats: fin.cats };
  }
  return { input: text, matchedBy: "none", finCategory: null, cats: [] };
}

export type BestCardQuery = { category?: string; merchant?: string; amountCents?: number; abroad?: boolean; date?: string };

/** Ranked cards for one purchase; caps count bonus spend already on the card this period. */
export async function bestCardFor(q: BestCardQuery) {
  const day = q.date ?? today();
  const [cards, query] = await Promise.all([listCards({ activeOnly: true }), resolveQuery(q)]);
  const capUse = await capUseOn(cards, day);
  return { query, day, abroad: !!q.abroad, ranked: rankCards(cards, { cats: query.cats, day, abroad: q.abroad, amountCents: q.amountCents, capUse }) };
}
export type BestCardResult = Awaited<ReturnType<typeof bestCardFor>>;

type Tally = { spendCents: number; earned: number; best: number };
const addTo = <K>(m: Map<K, Tally & Record<string, unknown>>, k: K, init: () => Tally & Record<string, unknown>, s: number, e: number, b: number) => {
  const row = m.get(k) ?? init();
  row.spendCents += s; row.earned += e; row.best += b;
  m.set(k, row);
};

/**
 * What card spend in [from, to] earned vs routing each purchase to the best
 * card held. Both worlds track their own cap use, from the start of `from`'s
 * year so a quarter half-spent before the range is respected. Portal-only and
 * foreign-fee effects are ignored: the ledger does not say how a trip was booked.
 */
export async function missedRewards(range: { from: string; to: string }) {
  const cards = await listCards({ activeOnly: true });
  const byAccount = new Map(cards.filter((c) => c.accountId).map((c) => [c.accountId!, c]));
  const index = new Map((await categoryIndex()).map((c) => [c.id, c.cats]));
  const spend = await cardSpend([...byAccount.keys()], `${range.from.slice(0, 4)}-01-01`, range.to);
  const actualUse: CapUse = new Map();
  const bestUse: CapUse = new Map();
  const consume = (use: CapUse, card: CardView, cats: CardCategory[], day: string, cents: number) => {
    const bonus = bonusRate(card, cats, day);
    if (!bonus?.capCents) return;
    const key = capUseKey(card.id, bonus, day);
    use.set(key, (use.get(key) ?? 0) + cents);
  };
  const byCategory = new Map<string, Tally & { bestCard: Map<string, number> }>();
  const byMerchant = new Map<string, Tally & { used: Map<string, number>; bestCard: Map<string, number> }>();
  const byCard = new Map<string, Tally>();
  const total: Tally = { spendCents: 0, earned: 0, best: 0 };
  for (const t of spend) {
    const card = byAccount.get(t.accountId)!;
    const cats = (t.categoryId && index.get(t.categoryId)) || [];
    const base = { cats, day: t.day, amountCents: t.spendCents };
    const actual = scoreCard(card, { ...base, capUse: actualUse });
    const best = rankCards(cards, { ...base, capUse: bestUse })[0] ?? actual;
    const earned = (t.spendCents * actual.valueBp) / 10_000;
    const switchTo = best.valueBp > actual.valueBp ? cards.find((c) => c.id === best.cardId) ?? card : card;
    const bestValue = (t.spendCents * scoreCard(switchTo, { ...base, capUse: bestUse }).valueBp) / 10_000;
    consume(actualUse, card, cats, t.day, t.spendCents);
    consume(bestUse, switchTo, cats, t.day, t.spendCents);
    if (t.day < range.from) continue;
    const bestName = switchTo.name;
    total.spendCents += t.spendCents; total.earned += earned; total.best += bestValue;
    const cat = t.categoryName ?? "Uncategorized";
    addTo(byCategory, cat, () => ({ spendCents: 0, earned: 0, best: 0, bestCard: new Map() }), t.spendCents, earned, bestValue);
    const bc = byCategory.get(cat)!.bestCard;
    bc.set(bestName, (bc.get(bestName) ?? 0) + bestValue - earned);
    const merchant = t.merchant || "(unknown)";
    addTo(byMerchant, merchant, () => ({ spendCents: 0, earned: 0, best: 0, used: new Map(), bestCard: new Map() }), t.spendCents, earned, bestValue);
    const m = byMerchant.get(merchant)!;
    m.used.set(card.name, (m.used.get(card.name) ?? 0) + bestValue - earned);
    m.bestCard.set(bestName, (m.bestCard.get(bestName) ?? 0) + bestValue - earned);
    addTo(byCard, card.name, () => ({ spendCents: 0, earned: 0, best: 0 }), t.spendCents, earned, bestValue);
  }
  /** The card carrying the most missed value: the one used wrongly, and the one that should have been. */
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const cents = (t: Tally) => ({ spendCents: t.spendCents, earnedCents: Math.round(t.earned), bestCents: Math.round(t.best), missedCents: Math.round(t.best - t.earned) });
  return {
    from: range.from, to: range.to,
    totals: cents(total),
    byCategory: [...byCategory].map(([category, t]) => ({ category, ...cents(t), bestCard: top(t.bestCard) }))
      .sort((a, b) => b.missedCents - a.missedCents || b.spendCents - a.spendCents),
    topMerchants: [...byMerchant].map(([merchant, t]) => ({ merchant, usedCard: top(t.used), bestCard: top(t.bestCard), ...cents(t) }))
      .filter((m) => m.missedCents > 0).sort((a, b) => b.missedCents - a.missedCents).slice(0, 10),
    byCard: [...byCard].map(([card, t]) => ({ card, ...cents(t) })),
    unlinkedCards: cards.filter((c) => !c.accountId).map((c) => c.name),
  };
}
export type MissedRewards = Awaited<ReturnType<typeof missedRewards>>;

/** Everything an assistant needs to answer "which card?", as one compact value plus a text rendering. */
export async function cardsContext(day = today()) {
  const cards = await listCards({ activeOnly: true });
  const uses = bestUses(cards, day);
  const accountNames = new Map((await db.select({ id: accounts.id, name: accounts.name }).from(accounts)).map((a) => [a.id, a.name]));
  const summary = cards.map((c) => ({
    name: c.name, issuer: c.issuer, account: c.accountId ? accountNames.get(c.accountId) ?? `#${c.accountId}` : null,
    currency: c.rewardCurrency, base: pctBp(c.baseRateBp),
    bonuses: c.rates.filter((r) => activeOn(r, day) || (r.from ?? "") > day).map((r) => [
      `${pctBp(r.rateBp)} ${r.category}`, r.via && `via ${r.via}`, r.capCents && `cap ${formatCents(r.capCents)}/${r.period ?? "year"}`,
      (r.from || r.to) && `${r.from ?? ""}..${r.to ?? ""}`, r.activation && "activate", r.note,
    ].filter(Boolean).join(" ")),
    annualFee: formatCents(c.annualFeeCents), foreignFee: c.foreignFeeBp == null ? "unknown" : pctBp(c.foreignFeeBp),
    useFor: uses.get(c.id) ?? [], perks: c.perks, note: c.note,
  }));
  const text = [`Credit cards as of ${day} (rates are cash-equivalent; abroad, prefer a card with a known 0% foreign fee):`,
    ...summary.map((s) => `- ${s.name}${s.account ? ` [${s.account}]` : ""}: ${s.base} base${s.bonuses.length ? `; ${s.bonuses.join("; ")}` : ""}; fee ${s.annualFee}/yr; FX ${s.foreignFee}. Use for: ${s.useFor.join(", ") || "nothing (another card wins everywhere)"}.`),
  ].join("\n");
  return { day, cards: summary, text };
}

/** Expense categories in the ledger, for the "which card?" picker. */
export async function pickerCategories(): Promise<string[]> {
  return (await categoryIndex()).filter((c) => c.kind === "expense").map((c) => c.name).sort();
}
