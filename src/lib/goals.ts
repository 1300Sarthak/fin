import "server-only";
import { z } from "zod";
import { db } from "@/db";
import { accounts, categories, goals, goalAccounts, goalType, transactions, type Goal, type GoalType } from "@/db/schema";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { isoDate } from "@/lib/format";
import { limitFor, type ContributionLimit, type LimitSource } from "@/lib/contribution-limits";
import {
  PROGRESS_KINDS, PROGRESS_KIND_LABEL, annualWindow, contributionDeadline, count401k, countAnnualContributions, findLoanPayments,
  isStudentLoanInterestGoal, limitForGoal, plan401k, type AnnualWindow, type ContributionEvent, type CountedRow, type K401Plan,
  type LoanPaymentRow, type ProgressKind,
} from "@/lib/goals-core";

export type GoalInput = {
  name: string;
  type?: GoalType;
  targetCents?: number;
  priority?: number;
  annualCapCents?: number | null;
  linkedAccountId?: number | null;
  parentGoalId?: number | null;
  accountIds?: number[];
  progressKind?: ProgressKind;
  taxYear?: number | null;
  manualProgressCents?: number | null;
};

const cents = z.number().int().min(0).max(1_000_000_000);
const id = z.number().int().positive();
/** Every goal write (web and CLI) goes through this; unknown fields are refused. */
export const goalInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  type: z.enum(goalType).optional(),
  targetCents: cents.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  annualCapCents: cents.nullable().optional(),
  linkedAccountId: id.nullable().optional(),
  parentGoalId: id.nullable().optional(),
  accountIds: z.array(id).max(50).optional(),
  progressKind: z.enum(PROGRESS_KINDS).optional(),
  taxYear: z.number().int().min(2000).max(2100).nullable().optional(),
  manualProgressCents: cents.nullable().optional(),
}).strict();
export const goalPatchSchema = goalInputSchema.partial().strict();

/** A tax-year measure needs a year; a balance goal ignores one. */
function assertKindYear(kind: ProgressKind | undefined, year: number | null | undefined) {
  if (kind && kind !== "balance" && year == null) throw new Error(`"${PROGRESS_KIND_LABEL[kind]}" needs a tax year`);
}

/** Keep the hierarchy one level deep and acyclic. */
async function assertValidParent(parentGoalId: number | null | undefined, selfId?: number) {
  if (parentGoalId == null) return;
  if (selfId != null && parentGoalId === selfId) {
    throw new Error("A goal cannot be its own parent");
  }
  const parent = await db
    .select({ id: goals.id, parentGoalId: goals.parentGoalId })
    .from(goals)
    .where(eq(goals.id, parentGoalId))
    .get();
  if (!parent) throw new Error("Parent goal not found");
  if (parent.parentGoalId != null) throw new Error("Sub-goals can only be one level deep");

  // A goal that already has its own children can't itself become a sub-goal.
  if (selfId != null) {
    const child = await db
      .select({ id: goals.id })
      .from(goals)
      .where(eq(goals.parentGoalId, selfId))
      .get();
    if (child) throw new Error("A goal with sub-goals can't become a sub-goal");
  }
}

async function setAccountLinks(goalId: number, accountIds: number[]) {
  await db.delete(goalAccounts).where(eq(goalAccounts.goalId, goalId));
  if (accountIds.length) {
    await db.insert(goalAccounts).values(accountIds.map((accountId) => ({ goalId, accountId })));
  }
}

export async function createGoal(raw: GoalInput): Promise<number> {
  const input = goalInputSchema.parse(raw);
  assertKindYear(input.progressKind, input.taxYear);
  await assertValidParent(input.parentGoalId);
  const [row] = await db
    .insert(goals)
    .values({
      name: input.name.trim(),
      type: input.type ?? "custom",
      targetCents: input.targetCents ?? 0,
      priority: input.priority ?? 0,
      annualCapCents: input.annualCapCents ?? null,
      linkedAccountId: input.linkedAccountId ?? null,
      parentGoalId: input.parentGoalId ?? null,
      progressKind: input.progressKind ?? "balance",
      taxYear: input.taxYear ?? null,
      manualProgressCents: input.manualProgressCents ?? null,
    })
    .returning({ id: goals.id });
  if (input.accountIds?.length) await setAccountLinks(row.id, input.accountIds);
  return row.id;
}

export async function updateGoal(id: number, raw: Partial<GoalInput>): Promise<void> {
  const input = goalPatchSchema.parse(raw);
  const current = await db.select().from(goals).where(eq(goals.id, id)).get();
  if (!current) throw new Error(`no goal #${id}`);
  assertKindYear(input.progressKind ?? current.progressKind, input.taxYear !== undefined ? input.taxYear : current.taxYear);
  if (input.parentGoalId !== undefined) await assertValidParent(input.parentGoalId, id);

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.type !== undefined) set.type = input.type;
  if (input.targetCents !== undefined) set.targetCents = input.targetCents;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.annualCapCents !== undefined) set.annualCapCents = input.annualCapCents;
  if (input.linkedAccountId !== undefined) set.linkedAccountId = input.linkedAccountId;
  if (input.parentGoalId !== undefined) set.parentGoalId = input.parentGoalId;
  if (input.progressKind !== undefined) set.progressKind = input.progressKind;
  if (input.taxYear !== undefined) set.taxYear = input.taxYear;
  if (input.manualProgressCents !== undefined) set.manualProgressCents = input.manualProgressCents;
  if (Object.keys(set).length) await db.update(goals).set(set).where(eq(goals.id, id));

  if (input.accountIds !== undefined) await setAccountLinks(id, input.accountIds);
}

export async function deleteGoal(id: number): Promise<void> {
  // Reparent children to top-level rather than cascade-deleting them, then drop
  // join rows explicitly (don't rely on PRAGMA foreign_keys), then the goal.
  await db.update(goals).set({ parentGoalId: null }).where(eq(goals.parentGoalId, id));
  await db.delete(goalAccounts).where(eq(goalAccounts.goalId, id));
  await db.delete(goals).where(eq(goals.id, id));
}

/** Find a goal by exact name (case-insensitive) for the CLI. */
export async function findGoalByName(name: string): Promise<Goal | undefined> {
  return db.select().from(goals).where(sql`lower(${goals.name}) = ${name.trim().toLowerCase()}`).get();
}

/* ------------------------------ progress by kind ------------------------------ */

export type StudentLoanDetail = {
  interestPaidCents: number;
  /** Interest still deductible this year: the cap minus what is entered. */
  moreInterestCents: number;
  deductionCents: number;
  /** Tax the entered interest saves (take-home with vs without), and what the full cap would save. */
  taxSavedCents: number | null;
  fullCapSavesCents: number | null;
  marginalRate: number | null;
  magiCents: number | null;
  phaseOut: { fromCents: number; toCents: number; status: string } | null;
  paymentsFound: LoanPaymentRow[];
};

export type GoalProgress = {
  kind: ProgressKind;
  kindLabel: string;
  taxYear: number | null;
  currentCents: number;
  roomCents: number | null;
  /** Where the number comes from, one line. */
  source: string;
  deadline: string | null;
  window: AnnualWindow | null;
  limit: ContributionLimit | null;
  /** Ledger rows behind a contribution total. */
  rows: CountedRow[];
  /** 401(k): more expected from paychecks through Dec 31 (posting + projected), not counted in currentCents. */
  projectedCents: number | null;
  k401: (K401Plan & { limit415c: ContributionLimit | null }) | null;
  studentLoan: StudentLoanDetail | null;
  notes: string[];
  sources: LimitSource[];
};

const money$ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

async function loadContributions(from: string, to: string): Promise<ContributionEvent[]> {
  const { getInvestmentHistory } = await import("@/lib/investment-history");
  const h = await getInvestmentHistory({ from, to, kind: "contribution" });
  const typeOf = new Map(h.accounts.map((a) => [a.accountId, a.type]));
  return h.events.map((e) => ({ txnId: e.txnId, date: e.date, accountId: e.accountId, account: e.account, accountType: typeOf.get(e.accountId) ?? "", amountCents: e.amountCents, description: e.description, internal: e.internal }));
}

async function loadLoanPaymentRows(year: number): Promise<LoanPaymentRow[]> {
  const rows = await db
    .select({ txnId: transactions.id, postedAt: transactions.postedAt, accountId: transactions.accountId, account: accounts.name, merchant: transactions.merchantRaw, category: categories.name, amountCents: transactions.amountCents })
    .from(transactions).innerJoin(accounts, eq(accounts.id, transactions.accountId)).leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(eq(transactions.isExcluded, false), eq(transactions.isPending, false), lt(transactions.amountCents, 0),
      gte(transactions.postedAt, new Date(`${year}-01-01T00:00:00`)), lt(transactions.postedAt, new Date(`${year + 1}-01-01T00:00:00`))));
  return findLoanPayments(rows.map((r) => ({ txnId: r.txnId, date: isoDate(r.postedAt), accountId: r.accountId, account: r.account, merchant: r.merchant, category: r.category, amountCents: r.amountCents })), year);
}

/**
 * Progress for every tax-year goal (balance goals are resolved in planner.ts
 * and are not in the map). Reads the ledger once per year involved, and the
 * take-home estimate only when a 2026 401(k) or student-loan goal needs it.
 */
export async function getGoalProgress(gs: Goal[], today = isoDate(new Date())): Promise<Map<number, GoalProgress>> {
  const out = new Map<number, GoalProgress>();
  const annual = gs.filter((g) => g.progressKind !== "balance" && g.taxYear != null);
  if (!annual.length) return out;
  const years = annual.map((g) => g.taxYear!);
  const events = await loadContributions(`${Math.min(...years)}-01-01`, `${Math.max(...years) + 1}-04-15`);
  const needsTakeHome = annual.some((g) => g.taxYear === 2026 && (g.progressKind === "k401" || isStudentLoanInterestGoal(g)));
  const takeHome = needsTakeHome ? await (await import("@/lib/take-home")).getTakeHome(2026, { today }).catch(() => null) : null;

  for (const g of annual) {
    const year = g.taxYear!;
    const kind = g.progressKind;
    const isSli = isStudentLoanInterestGoal(g);
    const limit = limitForGoal(kind, year, g.targetCents, isSli);
    const deadline = contributionDeadline(kind, year);
    const notes: string[] = [];
    const sources: LimitSource[] = limit ? [limit.source] : [];
    if (limit?.status === "projected") notes.push(`The ${year} limit is ${limit.note ?? "projected"}.`);
    if (limit && g.targetCents !== limit.cents) notes.push(`Target ${money$(g.targetCents)} differs from the ${year} limit of ${money$(limit.cents)}.`);
    let currentCents = 0, source = "", rows: CountedRow[] = [], projectedCents: number | null = null;
    let k401: GoalProgress["k401"] = null, studentLoan: StudentLoanDetail | null = null;

    if (kind === "roth_ira" || kind === "hsa") {
      const c = countAnnualContributions(events, kind, year);
      currentCents = c.cents; rows = c.rows;
      source = `${kind === "hsa" ? "HSA" : "Roth IRA"} contributions for ${year} from the ledger (each double-booked deposit counted once${kind === "hsa" ? ", cash sweeps left out" : ""})`;
      if (c.otherYearCents) notes.push(`${money$(c.otherYearCents)} contributed in ${year} counted toward ${year - 1} (marked "prior year"), so it is left out here.`);
      if (deadline) notes.push(`Contributions for ${year} are allowed until the ${year + 1} filing deadline, ${longDay(deadline)} (extensions do not extend it).`);
      if (kind === "hsa") {
        const self = limitFor("hsa_self", year);
        if (limit?.kind === "hsa_family" && self) notes.push(`The family limit needs family HDHP coverage; on a self-only plan the ${year} cap is ${money$(self.cents)}. Employer HSA money counts toward the limit.`);
        else notes.push("Employer HSA money counts toward the limit.");
      }
      if (kind === "roth_ira") notes.push("Roth IRA eligibility phases out at higher incomes; the limit is shared with any traditional IRA.");
    } else if (kind === "k401") {
      const c = count401k(events, year);
      currentCents = c.cents; rows = c.rows;
      source = `Employee deferrals deposited in ${year}, from the ledger`;
      const l415 = limitFor("k415c", year);
      if (takeHome && year === 2026) {
        const p = takeHome.payroll;
        projectedCents = p.k401.postingCents + p.projected.deferral401kCents;
        source = `Deferrals deposited so far, from the take-home reconstruction; ${money$(projectedCents)} more expected through Dec 31 at ${(p.k401.rate * 100).toFixed(1)}% of pay`;
        k401 = { ...plan401k({ year, limitCents: g.targetCents, ytdCents: currentCents, postingCents: p.k401.postingCents, remainingChecks: p.remainingPaydays.length, perCheckGrossCents: p.perCheckCents, projectedCents: p.projected.deferral401kCents }), limit415c: l415 };
      } else if (l415) {
        k401 = { ...plan401k({ year, limitCents: g.targetCents, ytdCents: currentCents, postingCents: 0, remainingChecks: 0, perCheckGrossCents: 0, projectedCents: 0 }), verdict: "no paychecks left", message: year === 2026 ? "The payroll projection could not be built; only deposits so far are counted." : "Payroll projection is modelled for 2026 only.", limit415c: l415 };
      }
      if (l415) notes.push(`Employer match is not tracked yet. The overall 415(c) limit of ${money$(l415.cents)} (${l415.status}) covers your deferrals plus the match.`);
      notes.push("Deferrals must come out of paychecks dated by December 31; Roth and pre-tax deferrals share the limit.");
    } else if (kind === "manual") {
      currentCents = g.manualProgressCents ?? 0;
      source = g.manualProgressCents == null ? "Entered manually; nothing entered yet" : "Entered manually";
      if (isSli) {
        source = g.manualProgressCents == null ? "Interest paid, entered from the servicer or Form 1098-E; nothing entered yet" : "Interest paid, entered from the servicer or Form 1098-E";
        const cap = limit?.cents ?? 250_000;
        const sl = takeHome && year === 2026 ? takeHome.studentLoan : null;
        const phase = sl?.phaseOut ?? null;
        studentLoan = {
          interestPaidCents: currentCents, moreInterestCents: Math.max(0, cap - currentCents),
          deductionCents: sl?.deductionCents ?? Math.min(currentCents, cap),
          taxSavedCents: sl?.taxSavedCents ?? null, fullCapSavesCents: sl?.fullCapSavesCents ?? null, marginalRate: sl?.marginalRate ?? null, magiCents: sl?.magiCents ?? null,
          phaseOut: phase ? { fromCents: phase.from, toCents: phase.to, status: phase.status } : null,
          paymentsFound: await loadLoanPaymentRows(year),
        };
        if (phase) sources.push(phase.source);
        if (studentLoan.moreInterestCents > 0) notes.push(`Pay at least ${money$(studentLoan.moreInterestCents)} more in interest by December 31 to use the full ${money$(cap)} deduction. Only the interest part of a payment counts; principal does not, so a payment has to be larger than this.`);
        if (sl?.magiCents != null && phase) notes.push(`Your ${year} MAGI estimate is ${money$(sl.magiCents)}; the deduction phases out between ${money$(phase.from)} and ${money$(phase.to)} (single), so ${sl.magiCents <= phase.from ? "you qualify for all of it" : sl.magiCents >= phase.to ? "none of it is allowed" : "it is partly reduced"}.`);
        notes.push("You must be legally obligated on the loan and not claimed as someone's dependent. Married filing separately cannot take it.");
        if (studentLoan.paymentsFound.length) notes.push("Payments found in the ledger are shown for reference only and are not counted: a payment is mostly principal, and a payment to a school may be tuition rather than a loan.");
      }
    }

    out.set(g.id, {
      kind, kindLabel: PROGRESS_KIND_LABEL[kind], taxYear: year, currentCents,
      roomCents: g.targetCents > 0 ? Math.max(0, g.targetCents - currentCents) : null,
      source, deadline, window: annualWindow(kind, year, today), limit, rows, projectedCents, k401, studentLoan, notes,
      sources: [...new Map(sources.map((s) => [s.url, s])).values()],
    });
  }
  return out;
}

