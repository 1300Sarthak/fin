import { db } from "@/db";
import { accounts, businessExpenses, categories, incomeEntries, incomeSources, transactions } from "@/db/schema";
import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { computeSep } from "./sep";
import { getPlanningProfile } from "./financial-planning";
import { formatUSD } from "./format";
import { getTakeHome, type TakeHomeReport } from "./take-home";

export const EXPENSE_CATEGORIES = ["equipment", "software", "furniture", "supplies", "services", "travel", "other"] as const;

const nullableText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
export const expenseInputSchema = z.object({
  taxYear: z.number().int().min(2000).max(2100),
  datePurchased: nullableText(40),
  item: z.string().trim().min(1, "Item is required").max(200),
  amountCents: z.number().int().min(0).max(100_000_000).nullish().transform((v) => v ?? null),
  paymentMethod: nullableText(120),
  businessPct: z.number().int().min(0).max(100).default(100),
  category: nullableText(40),
  txnId: z.number().int().positive().nullish().transform((v) => v ?? null),
  note: nullableText(1000),
}).strict();
export type ExpenseInput = z.input<typeof expenseInputSchema>;
const patchSchema = expenseInputSchema.partial().strict();

export async function createExpense(input: unknown): Promise<number> {
  const values = expenseInputSchema.parse(input);
  const [row] = await db.insert(businessExpenses).values(values).returning({ id: businessExpenses.id });
  return row.id;
}

export async function updateExpense(id: number, patch: unknown): Promise<void> {
  // Keep only the keys the caller sent: optional fields would otherwise parse
  // to their default (100%, null) and silently overwrite stored values.
  const parsed = patchSchema.parse(patch) as Record<string, unknown>;
  const sent = new Set(Object.keys(patch as object));
  const values = Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k)));
  if (!Object.keys(values).length) throw new Error("Nothing to update");
  const done = await db.update(businessExpenses).set(values).where(eq(businessExpenses.id, id)).returning({ id: businessExpenses.id });
  if (!done.length) throw new Error(`No business expense #${id}`);
}

export async function deleteExpense(id: number): Promise<void> {
  const done = await db.delete(businessExpenses).where(eq(businessExpenses.id, id)).returning({ id: businessExpenses.id });
  if (!done.length) throw new Error(`No business expense #${id}`);
}

export const deductibleCents = (amountCents: number | null, pct: number) => (amountCents == null ? 0 : Math.round((amountCents * pct) / 100));

function flagsFor(e: { amountCents: number | null; paymentMethod: string | null; txnId: number | null }) {
  const flags: string[] = [];
  if (e.amountCents == null) flags.push("price missing");
  if (/gift card/i.test(e.paymentMethod ?? "")) flags.push("confirm gift-card portion");
  return flags;
}

export async function listExpenses(year: number) {
  const rows = await db.select().from(businessExpenses).where(eq(businessExpenses.taxYear, year)).orderBy(asc(businessExpenses.datePurchased), asc(businessExpenses.id));
  return rows.map((e) => ({ ...e, createdAt: undefined, deductibleCents: deductibleCents(e.amountCents, e.businessPct), flags: flagsFor(e) }));
}
export type BusinessExpenseRow = Awaited<ReturnType<typeof listExpenses>>[number];

const yearBounds = (year: number) => [new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1))] as const;

/** Taxable self-employment income paid in the year, from the income log. */
export async function seIncome(year: number) {
  const taxable = sql<boolean>`coalesce(${incomeEntries.taxable}, ${incomeSources.taxTreatment} != 'nontaxable')`;
  const rows = await db
    .select({ name: incomeSources.name, taxable, cents: sql<number>`sum(${incomeEntries.amountCents})` })
    .from(incomeEntries)
    .innerJoin(incomeSources, eq(incomeSources.id, incomeEntries.sourceId))
    .where(and(eq(incomeSources.taxTreatment, "se"), sql`substr(${incomeEntries.paidOn}, 1, 4) = ${String(year)}`))
    .groupBy(incomeSources.name, taxable);
  const bySource = new Map<string, { name: string; taxableCents: number; nontaxableCents: number }>();
  for (const r of rows) {
    const s = bySource.get(r.name) ?? { name: r.name, taxableCents: 0, nontaxableCents: 0 };
    if (r.taxable) s.taxableCents += Number(r.cents); else s.nontaxableCents += Number(r.cents);
    bySource.set(r.name, s);
  }
  const sources = [...bySource.values()];
  return { grossCents: sources.reduce((n, s) => n + s.taxableCents, 0), nontaxableCents: sources.reduce((n, s) => n + s.nontaxableCents, 0), sources };
}

const SUGGEST_CATEGORY = /^(electronics|software)$|office/i;

/**
 * Ledger purchases in business-looking categories that are not on the list:
 * not linked by txnId, not refunded, and not covered by a subscription item
 * (a date range like "2026-03..2026-12" whose name contains the merchant).
 */
export async function suggestions(year: number, expenses: { txnId: number | null; item: string; datePurchased: string | null }[]) {
  const [from, to] = yearBounds(year);
  const rows = await db
    .select({ id: transactions.id, postedAt: transactions.postedAt, amountCents: transactions.amountCents, merchant: transactions.merchantRaw, category: categories.name, account: accounts.name })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(gte(transactions.postedAt, from), lt(transactions.postedAt, to), lt(transactions.amountCents, 0), eq(transactions.isTransfer, false), eq(transactions.isExcluded, false), eq(transactions.isPending, false)))
    .orderBy(asc(transactions.postedAt));
  const refunded = new Set((await db.select({ id: transactions.refundsTxnId }).from(transactions).where(isNotNull(transactions.refundsTxnId))).map((r) => r.id));
  const linked = new Set(expenses.map((e) => e.txnId).filter((id) => id != null));
  const subscriptions = expenses.filter((e) => e.datePurchased?.includes("..")).map((e) => e.item.toLowerCase());
  return rows
    .filter((r) => SUGGEST_CATEGORY.test(r.category) && !linked.has(r.id) && !refunded.has(r.id))
    .filter((r) => !subscriptions.some((item) => r.merchant && item.includes(r.merchant.toLowerCase())))
    .map((r) => ({ txnId: r.id, date: r.postedAt.toISOString().slice(0, 10), amountCents: -r.amountCents, merchant: r.merchant, category: r.category, account: r.account }));
}

/** W-2 wages from the saved tax profile (dollars), as an SS-wage proxy when there is no take-home model. */
async function profileWagesCents(year: number) {
  try {
    const p = await getPlanningProfile();
    return p.tax.year === year ? Math.round(p.tax.wagesBox1 * 100) : 0;
  } catch { return 0; }
}

const SS_WAGE_SOURCE = { ledger: "from your paychecks", "tax-profile": "from your tax profile (Box 1 + pre-tax deferrals)", "pay-stub": "from your pay stub and later paychecks", override: "as entered" } as const;

/**
 * The W-2 figures the SEP math needs, each with where it came from: an entered
 * --w2-deferrals wins, else the take-home reconstruction (2026, once it has
 * seen a paycheck), else the tax profile's Box 1 and unknown deferrals.
 */
export async function w2ForSep(year: number, deferralsOverrideCents?: number | null) {
  let th: TakeHomeReport | null = null;
  if (year === 2026) th = await getTakeHome(year).catch(() => null);
  if (th && th.w2.basis === "ledger" && !th.payroll.paychecks.length) th = null;
  const entered = deferralsOverrideCents != null ? { cents: deferralsOverrideCents, source: "as entered" } : null;
  if (!th) {
    const wages = await profileWagesCents(year);
    return { ssWagesCents: wages, ssWagesSource: wages ? "from your tax profile (Box 1)" : "none entered ($0 assumed)", deferralsCents: entered?.cents ?? null, deferralsSource: entered?.source ?? null };
  }
  const w = th.sepW2, posting = th.payroll.k401.postingCents;
  const fromPaychecks = `from your paychecks: ${formatUSD(w.ytdCents - posting)} deferred so far + ${formatUSD(w.projectedCents + posting)} projected through Dec 31`;
  const derived = w.deferralsEntered ? { cents: w.deferralsCents, source: "from your take-home settings" } : { cents: w.deferralsCents, source: fromPaychecks };
  const d = entered ?? derived;
  return { ssWagesCents: w.ssWagesCents, ssWagesSource: SS_WAGE_SOURCE[th.w2.basis], deferralsCents: d.cents, deferralsSource: d.source };
}

export async function businessYear(year: number, opts: { w2DeferralsCents?: number | null } = {}) {
  const [expenses, income, w2] = await Promise.all([listExpenses(year), seIncome(year), w2ForSep(year, opts.w2DeferralsCents)]);
  const w2SsWagesCents = w2.ssWagesCents;
  const byCategory = new Map<string, { category: string; spentCents: number; deductibleCents: number; count: number }>();
  for (const e of expenses) {
    const key = e.category ?? "uncategorized";
    const c = byCategory.get(key) ?? { category: key, spentCents: 0, deductibleCents: 0, count: 0 };
    c.spentCents += e.amountCents ?? 0; c.deductibleCents += e.deductibleCents; c.count++;
    byCategory.set(key, c);
  }
  const totals = {
    spentCents: expenses.reduce((n, e) => n + (e.amountCents ?? 0), 0),
    deductibleCents: expenses.reduce((n, e) => n + e.deductibleCents, 0),
    count: expenses.length,
    missingPriceCount: expenses.filter((e) => e.amountCents == null).length,
    linkedCount: expenses.filter((e) => e.txnId != null).length,
  };
  const sep = computeSep({ year, seGrossCents: income.grossCents, deductibleExpensesCents: totals.deductibleCents, w2SsWagesCents, w2DeferralsCents: w2.deferralsCents, w2Sources: { ssWages: w2.ssWagesSource, deferrals: w2.deferralsSource ?? undefined } });
  return {
    year, expenses, totals: { ...totals, unlinkedCount: totals.count - totals.linkedCount },
    byCategory: [...byCategory.values()].sort((a, b) => b.deductibleCents - a.deductibleCents),
    income, w2SsWagesCents, sep,
    suggestions: await suggestions(year, expenses),
    disclaimer: "Planning illustration only, not tax advice. Confirm Schedule C deductions, business-use percentages, and retirement contributions with a qualified tax professional.",
  };
}
export type BusinessYear = Awaited<ReturnType<typeof businessYear>>;
