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
import { applyCli, CLI_KIND, undoCli } from "./cli-writes";
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

async function insertProposal(kind: ChangeKind, txnId: number, summary: string, before: Json, after: Json, origin: "assistant" | "cli"): Promise<Change> {
  await expireStale();
  // A newer proposal for the same row and kind replaces the older one.
  await db.update(ledgerChanges).set(discarded("replaced"))
    .where(and(eq(ledgerChanges.txnId, txnId), eq(ledgerChanges.kind, kind), eq(ledgerChanges.status, "proposed")));
  const [row] = await db.insert(ledgerChanges).values({
    kind, txnId, summary, origin, beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after),
  }).returning();
  return (await toChanges([row]))[0];
}

/* -------------------------------- proposing --------------------------------- */

export async function proposeRecategorize(txnId: number, categoryId: number, origin: "assistant" | "cli" = "assistant"): Promise<Change> {
  const t = await loadTxn(txnId);
  requireSpendable(t, "recategorising");
  if (t.transferPairTxnId != null) throw new ChangeError("invalid", "This row is half of a manual transfer; unlink it in Transfers first.");
  const cat = await db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!cat) throw new ChangeError("invalid", "Unknown category.");
  if (t.categoryId === categoryId) throw new ChangeError("invalid", `#${txnId} is already in ${cat.name}.`);
  const from = t.categoryId == null ? null : (await db.select({ name: categories.name }).from(categories).where(eq(categories.id, t.categoryId)).get())?.name ?? null;
  return insertProposal("recategorize", txnId,
    `Move "${clean(t.merchantRaw)}" (${usd(t.amountCents)}) from ${from ?? "Uncategorized"} to ${cat.name}. Applying also remembers ${cat.name} for this merchant.`,
    { categoryId: t.categoryId, categorySource: t.categorySource, categoryConfidence: t.categoryConfidence, isTransfer: t.isTransfer },
    { categoryId, categoryName: cat.name, categoryKind: cat.kind }, origin);
}

export async function proposeSplit(txnId: number, shareCents: number, origin: "assistant" | "cli" = "assistant"): Promise<Change> {
  const t = await loadTxn(txnId);
  requireSpendable(t, "splitting");
  const total = -t.amountCents;
  if (t.amountCents >= 0) throw new ChangeError("invalid", "Only a purchase (money out) can be split.");
  if (t.isPending) throw new ChangeError("invalid", "This purchase is still pending and its amount can change; split it once it posts.");
  if (t.isRefund || t.isExcluded || isInvestmentAccountType(t.accountType) || isCashSweep(t)) throw new ChangeError("invalid", "This row does not count as spending, so there is nothing to split.");
  if (!Number.isInteger(shareCents) || shareCents < 0 || shareCents >= total) throw new ChangeError("invalid", `Your share must be at least $0 and less than the ${usd(total)} total.`);
  const reimbursed = total - shareCents;
  if ((await otherRefundsCents(txnId)) > 0) throw new ChangeError("invalid", "A refund or reimbursement is already linked to this purchase; a split on top would count the same money twice.");
  const existing = await findSplitRow(txnId);
  if (existing && existing.amountCents === reimbursed) throw new ChangeError("invalid", `#${txnId} is already split with your share at ${usd(shareCents)}.`);
  return insertProposal("split", txnId,
    `Count only your ${usd(shareCents)} of the ${usd(total)} at "${clean(t.merchantRaw)}"; ${usd(reimbursed)} is treated as paid back by others.${existing ? " Replaces the earlier split." : ""}`,
    { purchase: purchaseState(t), splitRow: existing ?? null },
    { totalCents: total, shareCents, reimbursedCents: reimbursed }, origin);
}

export async function proposeReimbursement(paymentId: number, purchaseId: number, origin: "assistant" | "cli" = "assistant"): Promise<Change> {
  const pay = await loadTxn(paymentId);
  const buy = await loadTxn(purchaseId);
  if (pay.source === "split" || buy.source === "split") throw new ChangeError("invalid", "Split rows cannot be used here.");
  if (pay.isPending || buy.isPending) throw new ChangeError("invalid", "Pending rows can still change; wait until both have posted.");
  if (pay.amountCents <= 0) throw new ChangeError("invalid", "The payment must be money coming in.");
  if (pay.isRefund) throw new ChangeError("invalid", `#${paymentId} is already marked as a refund or reimbursement.`);
  if (pay.isTransfer || pay.isExcluded) throw new ChangeError("invalid", "Transfers and excluded rows cannot be reimbursements.");
  if (buy.amountCents >= 0 || buy.isRefund || buy.isTransfer || buy.isExcluded) throw new ChangeError("invalid", "The purchase must be a counted outflow.");
  if (pay.accountId !== buy.accountId) throw new ChangeError("invalid", "The ledger only links a reimbursement to a purchase on the same account. If the payment landed in a different account, propose a split instead.");
  if (pay.postedAt <= buy.postedAt) throw new ChangeError("invalid", "The payment must be dated after the purchase.");
  if (await findSplitRow(purchaseId)) throw new ChangeError("invalid", "That purchase is already split; reimbursing it too would count the same money twice. Undo the split first.");
  if ((await otherRefundsCents(purchaseId)) + pay.amountCents > -buy.amountCents) throw new ChangeError("invalid", "Refunds against this purchase would exceed what it cost.");
  return insertProposal("reimbursement", paymentId,
    `Treat the ${usd(pay.amountCents)} payment "${clean(pay.merchantRaw)}" as paying back "${clean(buy.merchantRaw)}" (${usd(buy.amountCents)}), so only the rest counts as spending.`,
    { isRefund: false, refundsTxnId: null, amountCents: pay.amountCents, accountId: pay.accountId, purchase: purchaseState(buy) },
    { isRefund: true, refundsTxnId: purchaseId, purchase: { id: buy.id, date: isoDate(buy.postedAt), merchant: buy.merchantRaw, amountCents: buy.amountCents } }, origin);
}

export async function proposeExclude(txnId: number, exclude: boolean, origin: "assistant" | "cli" = "assistant"): Promise<Change> {
  const t = await loadTxn(txnId);
  requireSpendable(t, exclude ? "excluding" : "including");
  if (t.isExcluded === exclude) throw new ChangeError("invalid", `#${txnId} is already ${exclude ? "excluded" : "included"}.`);
  return insertProposal(exclude ? "exclude" : "include", txnId,
    exclude ? `Exclude "${clean(t.merchantRaw)}" (${usd(t.amountCents)}) from every total; it stays visible in the ledger.`
      : `Count "${clean(t.merchantRaw)}" (${usd(t.amountCents)}) in totals again.`,
    { isExcluded: t.isExcluded }, { isExcluded: exclude }, origin);
}

/* ------------------------------- state machine ------------------------------ */

/** Discard keeps its time and reason in afterJson: the table has no discardedAt column. */
const discarded = (reason: "user" | "expired" | "replaced") => ({
  status: "discarded" as const,
  afterJson: sql`json_set(${ledgerChanges.afterJson}, '$.discardedAt', ${new Date().toISOString()}, '$.discardReason', ${reason})`,
});

/** Proposals nobody acted on within the TTL become discarded and can never apply. */
export async function expireStale(): Promise<void> {
  await db.update(ledgerChanges).set(discarded("expired"))
    .where(and(eq(ledgerChanges.status, "proposed"), lt(ledgerChanges.createdAt, new Date(Date.now() - PROPOSAL_TTL_MS))));
}

async function loadChange(id: number): Promise<LedgerChange> {
  const row = await db.select().from(ledgerChanges).where(eq(ledgerChanges.id, id)).get();
  if (!row) throw new ChangeError("notfound", `No change #${id}.`);
  return row;
}

const g = globalThis as unknown as { __ledgerChangeLock?: Promise<unknown> };
/** One apply or undo at a time, even across route bundles in the same process. */
function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = (g.__ledgerChangeLock ?? Promise.resolve()).then(job, job);
  g.__ledgerChangeLock = run.catch(() => undefined);
  return run;
}

const stale = (why: string) => new ChangeError("stale", `${why} Nothing was changed; ask the assistant to propose it again.`);

/** The ledger must still look exactly like it did when the change was proposed. */
async function assertUnchanged(c: LedgerChange, before: Json, after: Json) {
  const t = await loadTxn(c.txnId).catch(() => { throw stale("That transaction no longer exists."); });
  if (c.kind === "recategorize") {
    if (t.categoryId !== before.categoryId || t.categorySource !== before.categorySource || t.isTransfer !== before.isTransfer) throw stale("This transaction's category changed after the proposal.");
  } else if (c.kind === "exclude" || c.kind === "include") {
    if (t.isExcluded !== before.isExcluded) throw stale("This transaction's excluded state changed after the proposal.");
  } else if (c.kind === "reimbursement") {
    if (t.isRefund !== before.isRefund || t.refundsTxnId !== before.refundsTxnId || t.amountCents !== before.amountCents) throw stale("This payment changed after the proposal.");
    const buy = await loadTxn(after.refundsTxnId).catch(() => { throw stale("The purchase no longer exists."); });
    if (JSON.stringify(purchaseState(buy)) !== JSON.stringify(before.purchase)) throw stale("The purchase changed after the proposal.");
    if (await findSplitRow(buy.id)) throw stale("That purchase has been split since the proposal; reimbursing it too would count the same money twice.");
    if ((await otherRefundsCents(buy.id)) + t.amountCents > -buy.amountCents) throw stale("Refunds against that purchase would now exceed what it cost.");
  } else {
    const now = purchaseState(t);
    if (JSON.stringify(now) !== JSON.stringify(before.purchase)) throw stale("This purchase changed after the proposal.");
    const row = await findSplitRow(c.txnId);
    if ((row?.id ?? null) !== (before.splitRow?.id ?? null) || (row?.amountCents ?? null) !== (before.splitRow?.amountCents ?? null)) throw stale("The split on this purchase changed after the proposal.");
  }
}

const touched = (c: { txnId: number }, a: Json): number[] => [c.txnId, ...(a.refundsTxnId ? [a.refundsTxnId as number] : []), ...(a.purchase?.id ? [a.purchase.id as number] : [])];

/** Changes must unwind newest first: an older undo would clobber, or later resurrect, a newer change's state. */
async function assertNoNewerChange(c: LedgerChange, after: Json) {
  const mine = new Set(touched(c, after));
  const seq = (a: Json, row: LedgerChange) => (a.appliedSeq as number | undefined) ?? (row.appliedAt?.getTime() ?? 0);
  const rows = await db.select().from(ledgerChanges).where(and(eq(ledgerChanges.status, "applied"), ne(ledgerChanges.id, c.id)));
  for (const r of rows) {
    const a = JSON.parse(r.afterJson) as Json;
    if (seq(a, r) < seq(after, c) || (seq(a, r) === seq(after, c) && r.id < c.id)) continue;
    const samePayee = c.kind === "recategorize" && r.kind === "recategorize" && !!a.snapshot?.payee && a.snapshot.payee === after.snapshot?.payee;
    if (samePayee || touched(r, a).some((id) => mine.has(id))) throw new ChangeError("stale", `Change #${r.id} was applied after this one and touches the same ${samePayee ? "merchant" : "transaction"}. Undo the newer change first.`);
  }
}

/** Undo only if nothing has touched the row since the change was applied. */
async function assertStillApplied(c: LedgerChange, after: Json) {
  const t = await loadTxn(c.txnId).catch(() => { throw stale("That transaction no longer exists."); });
  const ok = c.kind === "recategorize" ? t.categoryId === after.categoryId
    : c.kind === "exclude" || c.kind === "include" ? t.isExcluded === after.isExcluded
    : c.kind === "reimbursement" ? t.isRefund && t.refundsTxnId === after.purchase.id
    : await findSplitRow(c.txnId).then((r) => r?.id === after.splitRowId && r?.amountCents === after.reimbursedCents);
  if (!ok) throw stale("This row was edited again after the change, so it cannot be undone safely.");
}

async function applyEdit(c: LedgerChange, before: Json, after: Json): Promise<Json> {
  if (c.kind === "recategorize") {
    const t = await loadTxn(c.txnId);
    const cacheKey = normalizePayee(t.merchantRaw);
    const rules = t.payeeNormalized ? await db.select().from(categoryRules).where(and(eq(categoryRules.pattern, t.payeeNormalized), eq(categoryRules.createdBy, "user"))) : [];
    const cache = cacheKey ? await db.select().from(merchantCache).where(eq(merchantCache.normalizedMerchant, cacheKey)) : [];
    // Recorded before the write, so a failure part-way can still be reverted exactly.
    after.snapshot = { payee: t.payeeNormalized, cacheKey, rules: rules.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })), cache: cache.map((r) => ({ ...r, updatedAt: r.updatedAt.getTime() })) };
    after.remembered = true;
    const { remembered } = await setManualCategory(c.txnId, after.categoryId);
    after.remembered = remembered;
  } else if (c.kind === "exclude" || c.kind === "include") {
    await setExcluded(c.txnId, after.isExcluded);
  } else if (c.kind === "reimbursement") {
    await setRefund(c.txnId, true, after.refundsTxnId);
  } else {
    const t = await loadTxn(c.txnId);
    if ((await otherRefundsCents(c.txnId)) > 0) throw stale("A refund or reimbursement was linked to this purchase after the proposal.");
    if (before.splitRow) {
      await db.update(transactions).set({ amountCents: after.reimbursedCents }).where(eq(transactions.id, before.splitRow.id));
      after.splitRowId = before.splitRow.id;
    } else {
      const [row] = await db.insert(transactions).values({
        accountId: t.accountId, postedAt: t.postedAt, amountCents: after.reimbursedCents,
        merchantRaw: `Split reimbursement: ${t.merchantRaw}`, payeeNormalized: "split reimbursement",
        categoryId: t.categoryId, categorySource: "manual", source: "split", externalId: null,
        isRefund: true, refundsTxnId: t.id,
      }).returning({ id: transactions.id });
      after.splitRowId = row.id;
    }
  }
  return after;
}

/** Put the ledger back to `before`. `force` also covers a half-finished apply. */
async function revertEdit(c: LedgerChange, before: Json, after: Json, force: boolean) {
  if (c.kind === "recategorize") {
    await db.update(transactions).set({ categoryId: before.categoryId, categorySource: before.categorySource, categoryConfidence: before.categoryConfidence, isTransfer: before.isTransfer }).where(eq(transactions.id, c.txnId));
    const s = after.snapshot as Json | undefined;
    if (s && (force || after.remembered)) {
      if (s.payee) {
        await db.delete(categoryRules).where(and(eq(categoryRules.pattern, s.payee), eq(categoryRules.createdBy, "user")));
        for (const r of s.rules) await db.insert(categoryRules).values({ ...r, createdAt: new Date(r.createdAt) });
      }
      if (s.cacheKey) {
        await db.delete(merchantCache).where(eq(merchantCache.normalizedMerchant, s.cacheKey));
        for (const r of s.cache) await db.insert(merchantCache).values({ ...r, updatedAt: new Date(r.updatedAt) });
      }
    }
  } else if (c.kind === "exclude" || c.kind === "include") {
    await db.update(transactions).set({ isExcluded: before.isExcluded }).where(eq(transactions.id, c.txnId));
  } else if (c.kind === "reimbursement") {
    await setRefund(c.txnId, false);
  } else if (before.splitRow) {
    await db.update(transactions).set({ amountCents: before.splitRow.amountCents }).where(eq(transactions.id, before.splitRow.id));
  } else if (after.splitRowId) {
    await db.delete(transactions).where(and(eq(transactions.id, after.splitRowId), eq(transactions.source, "split")));
  }
}

/** The only function that mutates the ledger on the assistant's behalf. */
export function applyChange(id: number): Promise<Change> {
  return serialised(async () => {
    await expireStale();
    const c = await loadChange(id);
    if (c.status !== "proposed") throw new ChangeError("state", c.status === "discarded" ? "That proposal was discarded or has expired (proposals last 30 minutes)." : `That change is already ${c.status}.`);
    const before = JSON.parse(c.beforeJson) as Json;
    let after = JSON.parse(c.afterJson) as Json;
    if (c.kind === CLI_KIND) {
      await applyCli(c, before, after);
      return (await toChanges([await loadChange(id)]))[0];
    }
    await assertUnchanged(c, before, after);
    await backupDatabase();
    try {
      after = await applyEdit(c, before, after);
      after.appliedSeq = Date.now();
      // Conditional so a racing discard wins instead of being overwritten.
      const won = await db.update(ledgerChanges).set({ status: "applied", appliedAt: new Date(), afterJson: JSON.stringify(after) })
        .where(and(eq(ledgerChanges.id, id), eq(ledgerChanges.status, "proposed"))).returning({ id: ledgerChanges.id });
      if (!won.length) throw new ChangeError("state", "That proposal was discarded before it could be applied.");
    } catch (e) {
      await revertEdit(c, before, after, true);
      throw e instanceof ChangeError ? e : new ChangeError("state", e instanceof Error ? e.message : "The edit could not be applied.");
    }
    return (await toChanges([await loadChange(id)]))[0];
  });
}

export function undoChange(id: number): Promise<Change> {
  return serialised(async () => {
    const c = await loadChange(id);
    if (c.status !== "applied") throw new ChangeError("state", `Only an applied change can be undone; this one is ${c.status}.`);
    const before = JSON.parse(c.beforeJson) as Json;
    const after = JSON.parse(c.afterJson) as Json;
    if (c.kind === CLI_KIND) {
      await undoCli(c, before, after);
      return (await toChanges([await loadChange(id)]))[0];
    }
    await assertStillApplied(c, after);
    await assertNoNewerChange(c, after);
    await backupDatabase();
    try { await revertEdit(c, before, after, false); }
    catch (e) { throw new ChangeError("state", e instanceof Error ? e.message : "The edit could not be undone."); }
    await db.update(ledgerChanges).set({ status: "undone", undoneAt: new Date() }).where(eq(ledgerChanges.id, id));
    return (await toChanges([await loadChange(id)]))[0];
  });
}

export function discardChange(id: number): Promise<Change> {
  return serialised(async () => {
    await expireStale();
    const c = await loadChange(id);
    if (c.status !== "proposed") throw new ChangeError("state", `Only a pending proposal can be discarded; this one is ${c.status}.`);
    await db.update(ledgerChanges).set(discarded("user")).where(and(eq(ledgerChanges.id, id), eq(ledgerChanges.status, "proposed")));
    return (await toChanges([await loadChange(id)]))[0];
  });
}

/** Live proposals awaiting approval; the assistant may not queue more than MAX_PENDING. */
export async function pendingCount(): Promise<number> {
  await expireStale();
  return (await db.select({ n: sql<number>`COUNT(*)` }).from(ledgerChanges).where(eq(ledgerChanges.status, "proposed")).get())?.n ?? 0;
}

/* --------------------------------- reading ---------------------------------- */

/** A "cli" change has no transaction (txnId 0): `txn` then carries the command and the proposal date. */
export async function toChanges(rows: LedgerChange[]): Promise<Change[]> {
  if (!rows.length) return [];
  const txns = await db.select({
    id: transactions.id, postedAt: transactions.postedAt, merchant: transactions.merchantRaw,
    amountCents: transactions.amountCents, category: categories.name,
  }).from(transactions).leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(inArray(transactions.id, [...new Set(rows.map((r) => r.txnId))]));
  const byId = new Map(txns.map((t) => [t.id, t]));
  return rows.map((r) => {
    const t = byId.get(r.txnId);
    const after = JSON.parse(r.afterJson) as Json;
    delete after.snapshot; // internal restore data, not for display
    delete after.appliedSeq;
    delete after.row;
    const cli = r.kind === CLI_KIND;
    return {
      id: r.id, kind: r.kind, status: r.status, summary: r.summary,
      txn: cli ? { id: 0, date: isoDate(r.createdAt), merchant: String(after.command ?? "fin"), amountCents: 0, category: null }
        : { id: r.txnId, date: t ? isoDate(t.postedAt) : "", merchant: t?.merchant ?? "(deleted)", amountCents: t?.amountCents ?? 0, category: t?.category ?? null },
      before: JSON.parse(r.beforeJson), after,
      createdAt: r.createdAt.toISOString(), appliedAt: r.appliedAt?.toISOString() ?? null, undoneAt: r.undoneAt?.toISOString() ?? null,
    };
  });
}

/** Applied, undone and live proposals touching `month`, newest first. A
 *  reimbursement also belongs to the month of the purchase it pays back. */
export async function listChanges(month?: string, statuses: ChangeStatus[] = ["proposed", "applied", "undone"]): Promise<Change[]> {
  await expireStale();
  const rows = await db.select().from(ledgerChanges).where(inArray(ledgerChanges.status, statuses)).orderBy(desc(ledgerChanges.createdAt), desc(ledgerChanges.id));
  const all = await toChanges(rows);
  if (!month) return all;
  const r = monthRange(month);
  const inMonth = (date: string | undefined) => !!date && date >= isoDate(r.start) && date <= isoDate(r.end);
  return all.filter((c) => inMonth(c.txn.date) || inMonth((c.after.purchase as { date?: string } | undefined)?.date));
}

/* ------------------------------- activity log ------------------------------- */

export type ActivityEvent = { at: string; action: "proposed" | "applied" | "undone" | "discarded"; detail?: string };
export type Activity = {
  id: number; kind: string; status: ChangeStatus; origin: "assistant" | "cli"; summary: string;
  /** The `fin` command that does the same thing from a terminal. */
  command: string;
  undoable: boolean;
  events: ActivityEvent[];
  /** Newest event time; the list is sorted by it. */
  at: string;
};

const quote = (s: string) => (/^[\w./:=@+-]+$/.test(s) ? s : JSON.stringify(s));
/** The equivalent CLI command for a change. Ledger edits map onto fin cat / exclude / refund-mark / split. */
function commandFor(r: LedgerChange, before: Json, after: Json): string {
  switch (r.kind as string) {
    case CLI_KIND: return String(after.command ?? `fin ${before.command}`);
    case "recategorize": return `fin cat ${r.txnId} ${quote(String(after.categoryName ?? after.categoryId))}`;
    case "exclude": return `fin exclude ${r.txnId}`;
    case "include": return `fin exclude ${r.txnId} --undo`;
    case "reimbursement": return `fin refund-mark ${r.txnId} --reverses ${after.refundsTxnId}`;
    case "split": return `fin split ${r.txnId} ${((after.shareCents ?? 0) / 100).toFixed(2)}`;
    default: return `fin changes`;
  }
}

/**
 * Every proposal, apply, undo and discard, newest first: the assistant's log.
 * `ledger_changes` is append-only for this purpose (rows change status, never
 * disappear), so this is the complete history.
 */
export async function listActivity(limit = 200): Promise<Activity[]> {
  await expireStale();
  const rows = await db.select().from(ledgerChanges).orderBy(desc(ledgerChanges.id)).limit(Math.min(Math.max(limit, 1), 1000));
  return rows.map((r) => {
    const before = JSON.parse(r.beforeJson) as Json;
    const after = JSON.parse(r.afterJson) as Json;
    const events: ActivityEvent[] = [{ at: r.createdAt.toISOString(), action: "proposed" }];
    if (r.appliedAt) events.push({ at: r.appliedAt.toISOString(), action: "applied" });
    if (r.undoneAt) events.push({ at: r.undoneAt.toISOString(), action: "undone" });
    if (r.status === "discarded") events.push({ at: typeof after.discardedAt === "string" ? after.discardedAt : r.createdAt.toISOString(), action: "discarded", detail: typeof after.discardReason === "string" ? after.discardReason : undefined });
    const undoable = r.kind === CLI_KIND ? !!after.undoable : true;
    return { id: r.id, kind: r.kind, status: r.status, origin: r.origin, summary: r.summary, command: commandFor(r, before, after), undoable, events, at: events.at(-1)!.at };
  }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
}
