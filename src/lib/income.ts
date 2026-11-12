import "server-only";
import { and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, categories, incomeEntries, incomeSources, incomeSourceTreatment, transactions } from "@/db/schema";
import { isoDate } from "@/lib/format";

/**
 * Income by job. Cash basis: an entry counts in the year it was PAID (paidOn),
 * not the year the work happened. W-2 sources are read straight off matching
 * deposits (pay is net of withholding); self-employment sources are logged
 * work, each linked to the deposit that paid it, so unpaid work and deposits
 * nobody claimed both surface.
 */
export type Source = typeof incomeSources.$inferSelect;
export type Entry = typeof incomeEntries.$inferSelect;
export type Deposit = { id: number; date: string; amountCents: number; account: string; accountId?: number; description: string };
export type Bucket = "w2" | "se" | "nontaxable";

export type EntryRow = Entry & { daysToPay: number | null; bucket: Bucket };
export type OwedRow = { entryId: number; workMonth: string | null; amountCents: number; expectedOn: string | null; overdue: boolean };
export type SourceSummary = {
  source: Source;
  totalCents: number;
  taxableCents: number;
  nontaxableCents: number;
  hours: number;
  effectiveRateCents: number | null;
  typicalLagDays: number | null;
  entries: EntryRow[];
  depositMonths: { month: string; cents: number; txnIds: number[] }[];
  owed: OwedRow[];
  owedCents: number;
  unmatched: Deposit[];
  unloggedMonths: string[];
};
export type IncomeOverview = {
  year: number;
  sources: SourceSummary[];
  byMonth: ({ month: string } & Record<string, number | string>)[];
  totals: Record<Bucket | "total", number> & { hours: number; avgRateCents: number | null };
};

const DEFAULT_LAG_DAYS = 14;
const DAY_MS = 86_400_000;
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) => new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
/** Last calendar day of a YYYY-MM month: work counts as done when the month closes. */
export const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS);

export function entryBucket(source: Pick<Source, "taxTreatment">, entry: Pick<Entry, "taxable">): Bucket {
  const taxable = entry.taxable ?? source.taxTreatment !== "nontaxable";
  return taxable ? (source.taxTreatment === "w2" ? "w2" : "se") : "nontaxable";
}

/** Hours x rate, rounded to the cent. 18.5h at $25 is $462.50. */
export const earnedCents = (hours: number, rateCents: number) => Math.round(hours * rateCents);

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export const matchesPattern = (pattern: string | null, text: string) =>
  !!pattern && text.toLowerCase().includes(pattern.toLowerCase());

/** Pure: everything one source contributes to `year`, given its entries and every deposit in the ledger. */
export function summarizeSource(source: Source, entries: Entry[], deposits: Deposit[], linkedTxnIds: Set<number>, year: number, today: string): SourceSummary {
  return summarizeWindow(source, entries, deposits, linkedTxnIds, `${year}-01-01`, `${year}-12-31`, today);
}

/**
 * Pure: one source over any inclusive [from, to] window. Paid entries count when
 * paidOn falls inside; unpaid work shows when its work month overlaps (or it has
 * no dates at all). The pay lag is lifetime; unlogged months run from the first
 * logged month in the window through the last closed month.
 */
export function summarizeWindow(source: Source, entries: Entry[], deposits: Deposit[], linkedTxnIds: Set<number>, from: string, to: string, today: string): SourceSummary {
  const paidIn = (d: string | null) => !!d && d >= from && d <= to;
  const workIn = (m: string | null) => !!m && m >= from.slice(0, 7) && m <= to.slice(0, 7);
  const paidInWindow = entries.filter((e) => paidIn(e.paidOn));
  const rows: EntryRow[] = entries
    .filter((e) => paidIn(e.paidOn) || (!e.paidOn && workIn(e.workMonth)) || (!e.paidOn && !e.workMonth))
    .map((e) => ({ ...e, bucket: entryBucket(source, e), daysToPay: e.paidOn && e.workMonth ? daysBetween(monthEnd(e.workMonth), e.paidOn) : null }))
    .sort((a, b) => (a.workMonth ?? a.paidOn ?? "").localeCompare(b.workMonth ?? b.paidOn ?? ""));
  const lag = median(entries.filter((e) => e.paidOn && e.workMonth).map((e) => daysBetween(monthEnd(e.workMonth!), e.paidOn!)));

  const mine = source.matchPattern ? deposits.filter((d) => paidIn(d.date) && matchesPattern(source.matchPattern, d.description)) : [];
  const unlinked = mine.filter((d) => !linkedTxnIds.has(d.id));
  // W-2 pay is the deposits themselves; for self-employment an unlinked deposit is a question.
  const w2Deposits = source.taxTreatment === "w2" ? unlinked : [];
  const depositMonths = new Map<string, { month: string; cents: number; txnIds: number[] }>();
  for (const d of w2Deposits) {
    const m = d.date.slice(0, 7);
    const row = depositMonths.get(m) ?? { month: m, cents: 0, txnIds: [] };
    row.cents += d.amountCents;
    row.txnIds.push(d.id);
    depositMonths.set(m, row);
  }

  let taxableCents = 0, nontaxableCents = 0, hours = 0, hourlyCents = 0;
  for (const e of paidInWindow) {
    if (entryBucket(source, e) === "nontaxable") nontaxableCents += e.amountCents;
    else taxableCents += e.amountCents;
    if (e.hours) { hours += e.hours; hourlyCents += e.amountCents; }
  }
  taxableCents += w2Deposits.reduce((s, d) => s + d.amountCents, 0);

  const owed = rows.filter((e) => !e.paidOn).map((e) => {
    const expectedOn = e.workMonth ? addDays(monthEnd(e.workMonth), lag ?? DEFAULT_LAG_DAYS) : null;
    return { entryId: e.id, workMonth: e.workMonth, amountCents: e.amountCents, expectedOn, overdue: !!expectedOn && expectedOn < today };
  });

  // Hourly sources: months since the first logged one, through last month, with nothing logged.
  const logged = new Set(entries.map((e) => e.workMonth).filter(Boolean));
  // From the first month ever logged (or the window start, if later): a gap at the start of the window still shows.
  const firstEver = [...logged].sort()[0] as string | undefined;
  const firstMonth = firstEver && firstEver <= to.slice(0, 7) ? (firstEver > from.slice(0, 7) ? firstEver : from.slice(0, 7)) : undefined;
  const unloggedMonths: string[] = [];
  if (source.hourlyRateCents && firstMonth) {
    const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const lastClosed = to.slice(0, 7) < lastMonth ? to.slice(0, 7) : lastMonth;
    for (let m = firstMonth; m <= lastClosed; m = addDays(monthEnd(m), 1).slice(0, 7)) if (!logged.has(m)) unloggedMonths.push(m);
  }

  return {
    source, taxableCents, nontaxableCents, hours,
    totalCents: taxableCents + nontaxableCents,
    effectiveRateCents: hours ? Math.round(hourlyCents / hours) : null,
    typicalLagDays: lag,
    entries: rows,
    depositMonths: [...depositMonths.values()].sort((a, b) => a.month.localeCompare(b.month)),
    owed,
    owedCents: owed.reduce((s, o) => s + o.amountCents, 0),
    unmatched: source.taxTreatment === "w2" ? [] : unlinked,
    unloggedMonths,
  };
}

/** Pure: stack every source by the month cash landed, and total by tax treatment. */
export function combine(year: number, sources: SourceSummary[]): IncomeOverview {
  const byMonth = Array.from({ length: 12 }, (_, i) => {
    const row: { month: string } & Record<string, number | string> = { month: `${year}-${String(i + 1).padStart(2, "0")}` };
    for (const s of sources) row[s.source.name] = 0;
    return row;
  });
  const totals = { w2: 0, se: 0, nontaxable: 0, total: 0, hours: 0, avgRateCents: null as number | null };
  let hourlyCents = 0;
  for (const s of sources) {
    const add = (paidOn: string, cents: number) => {
      const row = byMonth[Number(paidOn.slice(5, 7)) - 1];
      row[s.source.name] = (row[s.source.name] as number) + cents;
    };
    for (const e of s.entries) {
      if (!e.paidOn?.startsWith(String(year))) continue;
      add(e.paidOn, e.amountCents);
      totals[e.bucket] += e.amountCents;
      if (e.hours) { totals.hours += e.hours; hourlyCents += e.amountCents; }
    }
    for (const m of s.depositMonths) { add(m.month, m.cents); totals.w2 += m.cents; }
  }
  totals.total = totals.w2 + totals.se + totals.nontaxable;
  totals.avgRateCents = totals.hours ? Math.round(hourlyCents / totals.hours) : null;
  return { year, sources, byMonth, totals };
}

async function loadDeposits(): Promise<Deposit[]> {
  const rows = await db
    .select({ id: transactions.id, postedAt: transactions.postedAt, amountCents: transactions.amountCents, account: accounts.name, accountId: transactions.accountId, description: transactions.merchantRaw })
    .from(transactions).innerJoin(accounts, eq(accounts.id, transactions.accountId))
    // Refunds and transfers are never pay, even from a payer-named merchant.
    .where(and(gt(transactions.amountCents, 0), eq(transactions.isExcluded, false), eq(transactions.isPending, false), eq(transactions.isRefund, false), eq(transactions.isTransfer, false)));
  return rows.map((r) => ({ id: r.id, date: isoDate(r.postedAt), amountCents: r.amountCents, account: r.account, accountId: r.accountId, description: r.description }));
}

export async function getIncomeOverview(year: number, opts: { source?: string; today?: string } = {}): Promise<IncomeOverview> {
  const [sources, entries, deposits] = await Promise.all([
    db.select().from(incomeSources).where(eq(incomeSources.archived, false)).orderBy(incomeSources.id),
    db.select().from(incomeEntries),
    loadDeposits(),
  ]);
  const linked = new Set(entries.flatMap((e) => (e.txnId ? [e.txnId] : [])));
  const today = opts.today ?? isoDate(new Date());
  const wanted = opts.source ? sources.filter((s) => s.name.toLowerCase() === opts.source!.toLowerCase()) : sources;
  if (opts.source && !wanted.length) throw new Error(`no income source "${opts.source}" — known: ${sources.map((s) => s.name).join(", ") || "none"}`);
  return combine(year, wanted.map((s) => summarizeSource(s, entries.filter((e) => e.sourceId === s.id), deposits, linked, year, today)));
}

/** Per-job detail (entries, owed, pay lag, unlogged months, unmatched deposits) for any window. */
export async function getIncomeDetails(from: string, to: string, opts: { sources?: string[]; today?: string } = {}): Promise<SourceSummary[]> {
  const [sources, entries, deposits] = await Promise.all([
    db.select().from(incomeSources).where(eq(incomeSources.archived, false)).orderBy(incomeSources.id),
    db.select().from(incomeEntries),
    loadDeposits(),
  ]);
  const linked = new Set(entries.flatMap((e) => (e.txnId ? [e.txnId] : [])));
  const today = opts.today ?? isoDate(new Date());
  const wanted = opts.sources?.map((s) => s.toLowerCase());
  return sources
    .filter((s) => !wanted?.length || wanted.includes(s.name.toLowerCase()))
    .map((s) => summarizeWindow(s, entries.filter((e) => e.sourceId === s.id), deposits, linked, from, to, today));
}

/** Active job names, in id order — for filter chips. */
export async function incomeSourceNames(): Promise<string[]> {
  return (await db.select({ name: incomeSources.name }).from(incomeSources).where(eq(incomeSources.archived, false)).orderBy(incomeSources.id)).map((s) => s.name);
}

/** Taxable self-employment income paid in `year` — what Schedule C / SE tax / SEP room start from. */
export async function selfEmploymentIncomeCents(year: number): Promise<number> {
  return (await getIncomeOverview(year)).totals.se;
}

/* --------------------------------- writes --------------------------------- */

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "date must be YYYY-MM-DD");
const cents = z.number().int().min(0).max(100_000_000);
export const entryInputSchema = z.object({
  source: z.union([z.string().min(1), z.number().int().positive()]),
  workMonth: month.optional(),
  hours: z.number().min(0).max(744).optional(),
  rateCents: cents.optional(),
  amountCents: cents.optional(),
  taxable: z.boolean().optional(),
  paidOn: day.optional(),
  txnId: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
}).strict();
export const entryPatchSchema = entryInputSchema.omit({ source: true }).partial().extend({
  workMonth: month.nullable().optional(), paidOn: day.nullable().optional(), txnId: z.number().int().positive().nullable().optional(),
  taxable: z.boolean().nullable().optional(), note: z.string().max(500).nullable().optional(),
}).strict();
export const sourceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  taxTreatment: z.enum(incomeSourceTreatment),
  matchPattern: z.string().trim().min(2).max(80).optional(),
  hourlyRateCents: cents.optional(),
  note: z.string().max(500).optional(),
}).strict();

export async function findSource(ref: string | number): Promise<Source> {
  const all = await db.select().from(incomeSources);
  const hit = all.find((s) => (typeof ref === "number" ? s.id === ref : s.name.toLowerCase() === ref.trim().toLowerCase()));
  if (!hit) throw new Error(`no income source "${ref}" — known: ${all.map((s) => s.name).join(", ") || "none"}`);
  return hit;
}

/** The deposit, checked: it exists, is money in, and no other entry already claims it. */
async function claimableDeposit(txnId: number, exceptEntryId?: number) {
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, txnId));
  if (!txn) throw new Error(`no transaction #${txnId}`);
  if (txn.amountCents <= 0) throw new Error(`transaction #${txnId} is not a deposit`);
  const [other] = await db.select({ id: incomeEntries.id }).from(incomeEntries).where(eq(incomeEntries.txnId, txnId));
  if (other && other.id !== exceptEntryId) throw new Error(`transaction #${txnId} already pays entry #${other.id}`);
  return { paidOn: isoDate(txn.postedAt), amountCents: txn.amountCents };
}

export async function addEntry(raw: unknown): Promise<Entry> {
  const input = entryInputSchema.parse(raw);
  const source = await findSource(input.source);
  const deposit = input.txnId ? await claimableDeposit(input.txnId) : null;
  const rateCents = input.hours != null ? input.rateCents ?? source.hourlyRateCents ?? undefined : input.rateCents;
  const amountCents = input.amountCents
    ?? (input.hours != null && rateCents != null ? earnedCents(input.hours, rateCents) : deposit?.amountCents);
  if (amountCents == null) throw new Error(`give an amount, or hours on a source with a rate (${source.name} has none)`);
  if (!input.workMonth && !input.paidOn && !deposit) throw new Error("give a work month or a paid date");
  const [row] = await db.insert(incomeEntries).values({
    sourceId: source.id, workMonth: input.workMonth ?? null, hours: input.hours ?? null, rateCents: rateCents ?? null,
    amountCents, taxable: input.taxable ?? null, paidOn: input.paidOn ?? deposit?.paidOn ?? null,
    txnId: input.txnId ?? null, note: input.note ?? null,
  }).returning();
  return row;
}

export async function updateEntry(id: number, raw: unknown): Promise<Entry> {
  const patch = entryPatchSchema.parse(raw);
  const [existing] = await db.select().from(incomeEntries).where(eq(incomeEntries.id, id));
  if (!existing) throw new Error(`no income entry #${id}`);
  if (patch.txnId) {
    const deposit = await claimableDeposit(patch.txnId, id);
    patch.paidOn ??= deposit.paidOn;
  }
  // Re-derive the amount when hours or rate change and no amount was given.
  if (patch.amountCents == null && (patch.hours != null || patch.rateCents != null)) {
    const hours = patch.hours ?? existing.hours, rate = patch.rateCents ?? existing.rateCents;
    if (hours != null && rate != null) patch.amountCents = earnedCents(hours, rate);
  }
  const [row] = await db.update(incomeEntries).set(patch).where(eq(incomeEntries.id, id)).returning();
  return row;
}

export async function deleteEntry(id: number): Promise<void> {
  const gone = await db.delete(incomeEntries).where(eq(incomeEntries.id, id)).returning({ id: incomeEntries.id });
  if (!gone.length) throw new Error(`no income entry #${id}`);
}

/** Point an entry at the deposit that paid it; paidOn follows the deposit's date. `null` unlinks and marks it unpaid. */
export async function linkEntry(id: number, txnId: number | null): Promise<Entry> {
  if (txnId === null) return updateEntry(id, { txnId: null, paidOn: null });
  const { paidOn } = await claimableDeposit(txnId, id);
  return updateEntry(id, { txnId, paidOn });
}

export async function addSource(raw: unknown): Promise<Source> {
  const input = sourceInputSchema.parse(raw);
  const taken = (await db.select({ name: incomeSources.name }).from(incomeSources)).some((s) => s.name.toLowerCase() === input.name.toLowerCase());
  if (taken) throw new Error(`an income source named "${input.name}" already exists`);
  const [row] = await db.insert(incomeSources).values(input).returning();
  return row;
}

/** Deposits by id, for the CLI/page to show what an entry links to. */
export async function depositsById(ids: number[]): Promise<Map<number, Deposit>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: transactions.id, postedAt: transactions.postedAt, amountCents: transactions.amountCents, account: accounts.name, accountId: transactions.accountId, description: transactions.merchantRaw })
    .from(transactions).innerJoin(accounts, eq(accounts.id, transactions.accountId)).where(inArray(transactions.id, ids));
  return new Map(rows.map((r) => [r.id, { id: r.id, date: isoDate(r.postedAt), amountCents: r.amountCents, account: r.account, accountId: r.accountId, description: r.description }]));
}

/** Years that have any paid entry, for the year selector. */
export async function incomeYears(): Promise<number[]> {
  const rows = await db.select({ y: sql<string>`distinct substr(${incomeEntries.paidOn}, 1, 4)` }).from(incomeEntries);
  return rows.map((r) => Number(r.y)).filter(Boolean).sort();
}

/* ------------------------------ any time range ------------------------------ */

export type GroupBy = "week" | "month" | "quarter" | "year";
export type Basis = "paid" | "work";
export type RangeBucket = Bucket | "other";
export const OTHER = "Other";
/** One dated amount. `paid: false` only appears on the work basis: earned, not yet received. */
export type IncomeItem = { date: string; source: string; bucket: RangeBucket; cents: number; hours: number | null; paid: boolean; category?: string };
export type OtherDeposit = Deposit & { category: string };
export type RangeTotals = Record<RangeBucket | "total", number> & { hours: number; avgRateCents: number | null };
export type Period = { key: string; label: string; start: string; end: string; total: number; bySource: Record<string, number> } & Record<RangeBucket, number>;
export type RangeSource = {
  id: number | null; name: string; taxTreatment: Bucket | "unknown";
  totalCents: number; taxableCents: number; nontaxableCents: number; unpaidCents: number;
  hours: number; effectiveRateCents: number | null; series: number[]; unmatched: Deposit[];
};
export type IncomeRange = {
  from: string; to: string; groupBy: GroupBy; basis: Basis; earliest: string | null;
  periods: Period[]; sources: RangeSource[];
  other: { totalCents: number; byCategory: { category: string; totalCents: number; count: number }[]; deposits: OtherDeposit[] };
  /** Tax refunds and reimbursements: money in, but not earnings, so outside every total. */
  refunds: { totalCents: number; byCategory: { category: string; totalCents: number; count: number }[]; deposits: OtherDeposit[] };
  totals: RangeTotals;
  previous: { from: string; to: string; totals: RangeTotals; deltaCents: number; deltaPct: number | null };
  notes: string[];
};

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** "2026-01" or "2026-01-15" to a day; a month means its first day (`edge: "start"`) or last (`"end"`). */
export function rangeDay(raw: string, edge: "start" | "end"): string {
  if (MONTH.test(raw)) return edge === "start" ? `${raw}-01` : monthEnd(raw);
  if (DAY.test(raw) && new Date(utc(raw)).toISOString().slice(0, 10) === raw) return raw;
  throw new Error(`expected YYYY-MM or YYYY-MM-DD, got "${raw}"`);
}

