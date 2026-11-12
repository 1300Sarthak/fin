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

const shiftMonths = (m: string, by: number) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mm - 1 + by, 1)).toISOString().slice(0, 7);
};

/** First day of the period holding `day`. Weeks start Monday. */
export function periodStart(day: string, by: GroupBy): string {
  if (by === "month") return `${day.slice(0, 7)}-01`;
  if (by === "year") return `${day.slice(0, 4)}-01-01`;
  if (by === "quarter") return `${day.slice(0, 4)}-${String(Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  return addDays(day, -((new Date(utc(day)).getUTCDay() + 6) % 7));
}
const nextPeriod = (start: string, by: GroupBy) =>
  by === "week" ? addDays(start, 7) : `${shiftMonths(start.slice(0, 7), by === "month" ? 1 : by === "quarter" ? 3 : 12)}-01`;
function periodKey(start: string, by: GroupBy): { key: string; label: string } {
  if (by === "month") return { key: start.slice(0, 7), label: start.slice(0, 7) };
  if (by === "year") return { key: start.slice(0, 4), label: start.slice(0, 4) };
  if (by === "quarter") { const k = `${start.slice(0, 4)}-Q${(Number(start.slice(5, 7)) + 2) / 3}`; return { key: k, label: k }; }
  return { key: start, label: `week of ${start}` };
}

/** The equal-length stretch just before [from, to]: whole calendar months when the range is whole months, else days. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  if (from.endsWith("-01") && to === monthEnd(to.slice(0, 7))) {
    const n = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    return { from: `${shiftMonths(from.slice(0, 7), -n)}-01`, to: monthEnd(shiftMonths(to.slice(0, 7), -n)) };
  }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/**
 * Pure: every dated income amount on one basis. Paid basis dates an entry by
 * paidOn and skips unpaid work; work basis dates it by workDate, else the first
 * of its work month, else paidOn, and keeps unpaid work. W-2 pay and other
 * deposits have no work date, so both bases use the deposit date.
 */
export function incomeItems(sources: Source[], entries: Entry[], deposits: Deposit[], other: OtherDeposit[], basis: Basis): IncomeItem[] {
  const linked = new Set(entries.flatMap((e) => (e.txnId ? [e.txnId] : [])));
  const items: IncomeItem[] = [];
  for (const s of sources) {
    for (const e of entries.filter((x) => x.sourceId === s.id)) {
      const date = basis === "paid" ? e.paidOn : e.workDate ?? (e.workMonth ? `${e.workMonth}-01` : e.paidOn);
      if (date) items.push({ date, source: s.name, bucket: entryBucket(s, e), cents: e.amountCents, hours: e.hours, paid: !!e.paidOn });
    }
    if (s.taxTreatment !== "w2" || !s.matchPattern) continue;
    for (const d of deposits) {
      if (!linked.has(d.id) && matchesPattern(s.matchPattern, d.description)) items.push({ date: d.date, source: s.name, bucket: "w2", cents: d.amountCents, hours: null, paid: true });
    }
  }
  for (const d of other) items.push({ date: d.date, source: OTHER, bucket: "other", cents: d.amountCents, hours: null, paid: true, category: d.category });
  return items;
}

function totalsOf(items: IncomeItem[]): RangeTotals {
  const t: RangeTotals = { w2: 0, se: 0, nontaxable: 0, other: 0, total: 0, hours: 0, avgRateCents: null };
  let hourly = 0;
  for (const i of items) {
    t[i.bucket] += i.cents;
    t.total += i.cents;
    if (i.hours) { t.hours += i.hours; hourly += i.cents; }
  }
  t.avgRateCents = t.hours ? Math.round(hourly / t.hours) : null;
  return t;
}

function groupByCategory(rows: OtherDeposit[]) {
  const by = new Map<string, { category: string; totalCents: number; count: number }>();
  for (const d of rows) {
    const row = by.get(d.category) ?? { category: d.category, totalCents: 0, count: 0 };
    row.totalCents += d.amountCents;
    row.count++;
    by.set(d.category, row);
  }
  return [...by.values()].sort((a, b) => b.totalCents - a.totalCents);
}

/** Tax refunds and reimbursements are money in, not earnings. Pure, by category or description. */
export const isRefundLike = (d: Pick<OtherDeposit, "category" | "description">) =>
  /^(taxes|refunds?|reimbursements?)$/i.test(d.category) || /\btax refund\b|\breimburse/i.test(d.description);

/** Pure: the range report from items already narrowed to the wanted sources. `unmatched` is every source's unclaimed pattern deposits. */
export function aggregateIncome(
  items: IncomeItem[],
  sources: Source[],
  opts: { from?: string; to: string; groupBy: GroupBy; basis: Basis; includeOther: boolean; unmatched: Map<number, Deposit[]>; other: OtherDeposit[]; refunds?: OtherDeposit[] },
): IncomeRange {
  const earliest = items.reduce<string | null>((m, i) => (m == null || i.date < m ? i.date : m), null);
  const from = opts.from ?? (earliest && earliest < opts.to ? earliest : opts.to);
  const to = opts.to;
  if (from > to) throw new Error(`--from ${from} is after --to ${to}`);
  const inRange = items.filter((i) => i.date >= from && i.date <= to);

  const periods: Period[] = [];
  for (let s = periodStart(from, opts.groupBy); s <= to; s = nextPeriod(s, opts.groupBy)) {
    const end = addDays(nextPeriod(s, opts.groupBy), -1);
    periods.push({ ...periodKey(s, opts.groupBy), start: s < from ? from : s, end: end > to ? to : end, w2: 0, se: 0, nontaxable: 0, other: 0, total: 0, bySource: {} });
  }
  const names = [...sources.map((s) => s.name), ...(opts.includeOther ? [OTHER] : [])];
  for (const p of periods) for (const n of names) p.bySource[n] = 0;
  for (const i of inRange) {
    const p = periods.find((x) => i.date >= x.start && i.date <= x.end)!;
    p[i.bucket] += i.cents;
    p.total += i.cents;
    p.bySource[i.source] += i.cents;
  }

  const rangeSources: RangeSource[] = sources.map((s) => {
    const mine = inRange.filter((i) => i.source === s.name);
    const t = totalsOf(mine);
    return {
      id: s.id, name: s.name, taxTreatment: s.taxTreatment,
      totalCents: t.total, taxableCents: t.w2 + t.se, nontaxableCents: t.nontaxable,
      unpaidCents: mine.filter((i) => !i.paid).reduce((sum, i) => sum + i.cents, 0),
      hours: t.hours, effectiveRateCents: t.avgRateCents,
      series: periods.map((p) => p.bySource[s.name]),
      unmatched: (opts.unmatched.get(s.id) ?? []).filter((d) => d.date >= from && d.date <= to),
    };
  });
  const otherIn = opts.includeOther ? opts.other.filter((d) => d.date >= from && d.date <= to) : [];
  const byCategory = groupByCategory(otherIn);
  const refundsIn = (opts.refunds ?? []).filter((d) => d.date >= from && d.date <= to);

  const totals = totalsOf(inRange);
  const prev = previousRange(from, to);
  const prevTotals = totalsOf(items.filter((i) => i.date >= prev.from && i.date <= prev.to));
  const notes: string[] = [];
  if (opts.basis === "work") notes.push("Work basis: logged work counts in its work month (dated the 1st when no work date is logged), unpaid work included. W-2 pay and other deposits have no work date and count when deposited.");
  else notes.push("Paid basis: income counts when the money landed; unpaid work is left out.");
  if (opts.includeOther) notes.push(`"${OTHER}" is money in that the Earnings page counts but no income source claims (interest, bonuses, gifts). Its tax treatment is unknown, so it is outside the W-2 / self-employment / nontaxable totals. Tax refunds and reimbursements are money in but not earnings: they are left out of every total and listed separately.`);
  if (earliest && prev.to < earliest) notes.push(`The previous period (${prev.from} to ${prev.to}) is before the earliest income on record (${earliest}).`);
  return {
    from, to, groupBy: opts.groupBy, basis: opts.basis, earliest, periods, sources: rangeSources,
    other: { totalCents: otherIn.reduce((s, d) => s + d.amountCents, 0), byCategory, deposits: otherIn },
    refunds: { totalCents: refundsIn.reduce((s, d) => s + d.amountCents, 0), byCategory: groupByCategory(refundsIn), deposits: refundsIn },
    totals,
    previous: { ...prev, totals: prevTotals, deltaCents: totals.total - prevTotals.total, deltaPct: prevTotals.total ? ((totals.total - prevTotals.total) / prevTotals.total) * 100 : null },
    notes,
  };
}

const NOT_INCOME_ACCOUNTS = ["brokerage", "ira", "crypto", "hsa"] as const;

/**
 * Money in the Earnings page counts (src/lib/workspaces.ts `incomeActivity`):
 * positive, not a transfer, refund or exclusion, outside investment accounts,
 * and not coded as a transfer or investment. HSA accounts are also left out
 * here: their only "income" rows are the money-market sweep legs.
 */
async function loadEarningsDeposits(): Promise<OtherDeposit[]> {
  const rows = await db
    .select({ id: transactions.id, postedAt: transactions.postedAt, amountCents: transactions.amountCents, account: accounts.name, accountId: transactions.accountId, description: transactions.merchantRaw, category: categories.name, kind: categories.kind })
    .from(transactions).innerJoin(accounts, eq(accounts.id, transactions.accountId)).leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(gt(transactions.amountCents, 0), eq(transactions.isExcluded, false), eq(transactions.isPending, false), eq(transactions.isRefund, false), eq(transactions.isTransfer, false), notInArray(accounts.type, [...NOT_INCOME_ACCOUNTS])));
  return rows
    .filter((r) => r.kind !== "transfer" && r.kind !== "investment")
    .map((r) => ({ id: r.id, date: isoDate(r.postedAt), amountCents: r.amountCents, account: r.account, accountId: r.accountId, description: r.description, category: r.category ?? "Uncategorized" }));
}

/**
 * Income for any stretch of time, any grouping, either basis. `sources` names
 * jobs (case-insensitive) and may include "Other"; omitted means every job
 * plus Other. `from` omitted means the earliest income on record; `to` omitted
 * means today.
 */
export async function getIncomeRange(opts: { from?: string; to?: string; sources?: string[]; groupBy?: GroupBy; basis?: Basis; today?: string } = {}): Promise<IncomeRange> {
  const [all, entries, deposits, earnings] = await Promise.all([
    db.select().from(incomeSources).where(eq(incomeSources.archived, false)).orderBy(incomeSources.id),
    db.select().from(incomeEntries),
    loadDeposits(),
    loadEarningsDeposits(),
  ]);
  const known = [...all.map((s) => s.name), OTHER];
  for (const w of opts.sources ?? []) if (!known.some((k) => k.toLowerCase() === w.trim().toLowerCase())) throw new Error(`no income source "${w}" — known: ${known.join(", ")}`);
  const wanted = opts.sources?.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sources = wanted?.length ? all.filter((s) => wanted.includes(s.name.toLowerCase())) : all;
  const includeOther = !wanted?.length || wanted.includes(OTHER.toLowerCase());

  // Anything a job claims is not "other": linked deposits and every pattern match (W-2 pay, or a self-employment deposit awaiting a link).
  const linked = new Set(entries.flatMap((e) => (e.txnId ? [e.txnId] : [])));
  const unmatched = new Map<number, Deposit[]>();
  const claimed = new Set(linked);
  for (const s of all) {
    const mine = deposits.filter((d) => matchesPattern(s.matchPattern, d.description));
    for (const d of mine) claimed.add(d.id);
    if (s.taxTreatment !== "w2") unmatched.set(s.id, mine.filter((d) => !linked.has(d.id)));
  }
  const unclaimed = earnings.filter((d) => !claimed.has(d.id));
  const other = unclaimed.filter((d) => !isRefundLike(d));
  const refunds = unclaimed.filter(isRefundLike);
  const basis = opts.basis ?? "paid";
  const items = incomeItems(sources, entries, deposits, includeOther ? other : [], basis);
  return aggregateIncome(items, sources, {
    from: opts.from ? rangeDay(opts.from, "start") : undefined,
    to: opts.to ? rangeDay(opts.to, "end") : opts.today ?? isoDate(new Date()),
    groupBy: opts.groupBy ?? "month", basis, includeOther, unmatched, other, refunds,
  });
}
