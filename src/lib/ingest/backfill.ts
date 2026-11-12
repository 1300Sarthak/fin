import { asc } from "drizzle-orm";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { fetchSimplefin, simplefinToNormalized } from "./simplefin";
import { ingestAccounts } from "./adapter";
import { resolveAccessUrl } from "./sync";
import { planBackfillWindows, type BackfillWindow } from "./backfill-core";

export { planBackfillWindows, type BackfillWindow } from "./backfill-core";

/**
 * `fin sync --backfill --since YYYY-MM-DD`: walk older SimpleFIN history in
 * 45-day windows, newest first, through the exact ingest path a normal sync
 * uses. Nothing about ingest changes — upserts key on the provider's
 * transaction id, so re-running a window updates rows instead of doubling them,
 * and user edits (category, notes, refund links) are never written.
 *
 * Each window costs one SimpleFIN request, and the Bridge rate-limits per
 * token (about 24 a day), so the walk is capped and stops early once the
 * institutions have nothing older to give.
 */

export type BackfillWindowResult = BackfillWindow & { returned: number; inserted: number; updated: number; errors: string[] };
export type BackfillResult = {
  since: string;
  until: string;
  dryRun: boolean;
  windows: BackfillWindowResult[];
  /** Why the walk ended before `since`, if it did. */
  stoppedEarly: string | null;
};

const dayStartUnix = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000);

/** The day before the oldest row we hold: everything newer is already synced. */
async function defaultUntil(): Promise<string> {
  const first = await db.select({ postedAt: transactions.postedAt }).from(transactions).orderBy(asc(transactions.postedAt)).limit(1).get();
  const d = first?.postedAt ?? new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1)).toISOString().slice(0, 10);
}

export async function runBackfill(opts: {
  since: string;
  until?: string;
  windowDays?: number;
  maxRequests?: number;
  /** Plan only: no request leaves the machine. */
  dryRun?: boolean;
  /** Consecutive empty windows that mean "nothing older exists". */
  emptyStop?: number;
  pauseMs?: number;
}): Promise<BackfillResult> {
  const until = opts.until ?? (await defaultUntil());
  const plan = planBackfillWindows(opts.since, until, opts.windowDays ?? 45);
  const maxRequests = opts.maxRequests ?? 12;
  const result: BackfillResult = { since: opts.since, until, dryRun: !!opts.dryRun, windows: [], stoppedEarly: null };
  if (opts.dryRun) {
    result.windows = plan.map((w) => ({ ...w, returned: 0, inserted: 0, updated: 0, errors: [] }));
    if (plan.length > maxRequests) result.stoppedEarly = `would stop after ${maxRequests} requests (--max-requests)`;
    return result;
  }

  const url = await resolveAccessUrl();
  let empty = 0;
  for (const [i, w] of plan.entries()) {
    if (i >= maxRequests) {
      result.stoppedEarly = `request cap of ${maxRequests} reached; continue with --until ${plan[i].end}`;
      break;
    }
    if (i > 0 && opts.pauseMs !== 0) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 1500));
    // end-date is exclusive in the protocol, so ask through the start of the next day.
    const resp = await fetchSimplefin(url, { startDate: dayStartUnix(w.start), endDate: dayStartUnix(w.end) + 86_400 });
    const { accounts, errors } = simplefinToNormalized(resp);
    const returned = accounts.reduce((n, a) => n + a.transactions.length, 0);
    const summary = returned ? await ingestAccounts(accounts, "simplefin") : { newTransactions: 0, updatedTransactions: 0 };
    result.windows.push({ ...w, returned, inserted: summary.newTransactions, updated: summary.updatedTransactions, errors });
    empty = returned === 0 ? empty + 1 : 0;
    if (empty >= (opts.emptyStop ?? 2)) {
      result.stoppedEarly = `${empty} windows in a row came back empty; the institutions keep nothing older`;
      break;
    }
  }
  return result;
}
