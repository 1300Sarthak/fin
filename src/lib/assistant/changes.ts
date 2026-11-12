/**
 * Assistant ledger edits: propose, apply, discard, undo.
 *
 * The assistant never writes to `transactions`. A tool call only inserts a
 * `ledger_changes` row in status `proposed`; `applyChange` is the single path
 * from there to the ledger, and it is reached only by an explicit user action
 * (a button in the UI, or `fin split`). Every apply is preceded by a database
 * backup and re-checks that the row still looks the way it did when proposed.
 *
 * Why the writes are not wrapped in one SQL transaction: the edit helpers this
 * reuses (`setManualCategory`, `setRefund`, `setExcluded`) go through the
 * shared connection, and libSQL hands a transaction its own connection, so
 * calling them inside one would deadlock on the write lock. Instead each apply
 * is serialised, and any failure runs the same `revertChange` that undo uses.
 */
import { mkdirSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts, categories, categoryRules, ledgerChanges, merchantCache, transactions,
  type ChangeKind, type ChangeStatus, type LedgerChange,
} from "@/db/schema";
import { setManualCategory } from "@/lib/categorize";
import { setExcluded } from "@/lib/ledger";
import { setRefund } from "@/lib/refunds";
import { normalizePayee } from "@/lib/normalize";
import { isoDate } from "@/lib/format";
import { monthRange } from "@/lib/spending";
import { isCashSweep, isInvestmentAccountType } from "@/lib/cashflow-scope";

export const PROPOSAL_TTL_MS = 30 * 60_000;
export const BACKUPS_KEPT = 30;
const BACKUP_NAME = /^finance-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

export type ChangeErrorCode = "invalid" | "notfound" | "stale" | "state" | "backup";
/** A refusal the caller can show as-is; `code` picks the HTTP status. */
export class ChangeError extends Error {
  constructor(readonly code: ChangeErrorCode, message: string) { super(message); this.name = "ChangeError"; }
}

export type Change = {
  id: number;
  kind: ChangeKind;
  status: ChangeStatus;
  summary: string;
  txn: { id: number; date: string; merchant: string; amountCents: number; category: string | null };
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Untrusted free text from the bank: one short line, no control characters. */
export const clean = (s: string | null | undefined, max = 80) => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const MAX_PENDING = 25;
const usd = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

/* --------------------------------- backups ---------------------------------- */

function databaseFile(): string {
  const url = process.env.DATABASE_URL ?? "file:finance.db";
  if (!url.startsWith("file:") || url === "file::memory:") throw new ChangeError("backup", "Cannot back up a non-file database, so the edit was not applied.");
  return resolve(url.slice("file:".length).split("?")[0]);
}

/** Snapshot the whole database next to itself (mode 0700 dir), keeping the newest 30. */
export async function backupDatabase(): Promise<string> {
  try {
    const dir = join(dirname(databaseFile()), "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(dir, `finance-${stamp}.db`);
    await db.run(sql.raw(`VACUUM INTO '${target.replace(/'/g, "''")}'`));
    chmodSync(target, 0o600);
    const old = readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort().reverse().slice(BACKUPS_KEPT);
    for (const f of old) unlinkSync(join(dir, f));
    return target;
  } catch (e) {
    if (e instanceof ChangeError) throw e;
    throw new ChangeError("backup", "Could not back up the database, so the edit was not applied.");
  }
}

/* ------------------------------- row helpers -------------------------------- */

async function loadTxn(id: number) {
  const row = await db.select({
    id: transactions.id, accountId: transactions.accountId, postedAt: transactions.postedAt,
    amountCents: transactions.amountCents, merchantRaw: transactions.merchantRaw, payeeNormalized: transactions.payeeNormalized,
    categoryId: transactions.categoryId, categorySource: transactions.categorySource, categoryConfidence: transactions.categoryConfidence,
    isTransfer: transactions.isTransfer, isExcluded: transactions.isExcluded, isRefund: transactions.isRefund,
    refundsTxnId: transactions.refundsTxnId, isPending: transactions.isPending, source: transactions.source, transferPairTxnId: transactions.transferPairTxnId,
    accountType: accounts.type, accountName: accounts.name,
  }).from(transactions).innerJoin(accounts, eq(transactions.accountId, accounts.id)).where(eq(transactions.id, id)).get();
  if (!row) throw new ChangeError("notfound", `No transaction #${id}.`);
  return row;
}
type Txn = Awaited<ReturnType<typeof loadTxn>>;

const findSplitRow = (purchaseId: number) =>
  db.select({ id: transactions.id, amountCents: transactions.amountCents }).from(transactions)
    .where(and(eq(transactions.source, "split"), eq(transactions.refundsTxnId, purchaseId))).get();

/** Money already linked back to a purchase by real (non-split) refunds. */
async function otherRefundsCents(purchaseId: number): Promise<number> {
  const r = await db.select({ sum: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)` }).from(transactions).where(and(
    eq(transactions.refundsTxnId, purchaseId), eq(transactions.isRefund, true), eq(transactions.isTransfer, false),
    eq(transactions.isExcluded, false), ne(transactions.source, "split"),
  )).get();
  return r?.sum ?? 0;
}

const purchaseState = (t: Txn) => ({
  amountCents: t.amountCents, accountId: t.accountId, postedAt: Math.floor(t.postedAt.getTime() / 1000),
  isExcluded: t.isExcluded, isTransfer: t.isTransfer,
});

function requireSpendable(t: Txn, what: string) {
  if (t.source === "split") throw new ChangeError("invalid", `#${t.id} is a split row the assistant created; change the original purchase instead.`);
  if (t.isTransfer) throw new ChangeError("invalid", `#${t.id} is a transfer, so ${what} does not apply.`);
}

