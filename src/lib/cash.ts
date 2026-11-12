import { db } from "@/db";
import { accounts, transactions, balanceSnapshots } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { refuseSplitRow } from "@/lib/ledger";
import { z } from "zod";
import { complete, hasAnyProvider } from "@/lib/ai";
import { loadPrivacy, privateComplete } from "@/lib/assistant/privacy";
import { normalizePayee } from "@/lib/normalize";
import { isoDate, toCents } from "@/lib/format";
import { looksLikeSet, parseCashText, type CashCommand, type CashOp } from "./cash-core";

const CASH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: { type: "string", enum: ["set", "add", "subtract"] },
    amount: { type: "number" },
    note: { type: "string" },
    date: { type: "string" },
  },
  required: ["op", "amount", "note", "date"],
};

const CashParse = z.object({
  op: z.enum(["set", "add", "subtract"]),
  amount: z.number(),
  note: z.string(),
  date: z.string(),
});

export type { CashCommand, CashOp } from "./cash-core";

const CASH_NAME = "Cash";

/** The database or an open transaction on it. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getCashAccount(ex: Executor = db) {
  return ex
    .select()
    .from(accounts)
    .where(and(eq(accounts.name, CASH_NAME), eq(accounts.source, "manual")))
    .get();
}

async function getOrCreateCashAccount(ex: Executor = db) {
  const existing = await getCashAccount(ex);
  if (existing) return existing;
  const [created] = await ex
    .insert(accounts)
    .values({
      name: CASH_NAME,
      type: "cash",
      currency: "USD",
      currentBalanceCents: 0,
      isAsset: true,
      isActive: true,
      source: "manual",
    })
    .returning();
  return created;
}

/* ------------------------------- NLP parsing --------------------------------- */


const CASH_PARSE_TIMEOUT_MS = 15_000;

/** `send` is the provider call; tests pass a fake to see exactly what leaves. */
export async function parseCashCommand(text: string, send: typeof complete = complete): Promise<CashCommand> {
  if (send === complete && !hasAnyProvider()) return parseCashText(text);
  try {
    // The sentence is the user's own words and can name people or accounts, so
    // it goes out pseudonymised like research does; the note comes back rehydrated.
    const priv = await loadPrivacy();
    const res = await privateComplete(send, priv)({
      system:
        "Interpret a short message about the user's physical cash on hand. Decide whether it SETs the running total to an amount, ADDs to it, or SUBTRACTs from it; the dollar amount; a brief note (e.g. what it was spent on); and the calendar date if mentioned. Return date as YYYY-MM-DD, or an empty string if no date is mentioned. Examples: 'I have $200 in my wallet' -> set, 200. 'spent 15 on lunch yesterday' -> subtract, 15, note 'lunch', date yesterday in YYYY-MM-DD. 'add 50' -> add, 50. 'found a $20 bill' -> add, 20, note 'found bill'.",
      messages: [{ role: "user", content: priv.scrubText(text) }],
      maxTokens: 256,
      schema: { name: "cash_command", schema: CASH_SCHEMA },
      // Without this a stalled provider hangs the caller indefinitely.
      signal: AbortSignal.timeout(CASH_PARSE_TIMEOUT_MS),
    });
    const p = CashParse.parse(JSON.parse(res.text));
    const amountCents = toCents(p.amount || 0);
    // Do not let the model empty the balance. A zero amount, or a `set` the
    // text gives no evidence for, is what it returns when it did not
    // understand — hand those to the deterministic parser, which either reads
    // the text confidently or refuses it.
    if (!amountCents || (p.op === "set" && !looksLikeSet(text))) return parseCashText(text);
    return { op: p.op, amountCents, note: (p.note || "").slice(0, 60), date: p.date || undefined };
  } catch {
    // All providers failed (or returned malformed output) -> deterministic floor.
    return parseCashText(text);
  }
}

/* --------------------------------- apply ------------------------------------- */

export type CashResult = {
  balanceCents: number;
  op: CashOp;
  amountCents: number;
  deltaCents: number;
  note: string;
};

/** Deterministic apply (no AI) — shared by the manual buttons and the NLP box. */
export async function applyCashOp(
  op: CashOp,
  amountCents: number,
  note = "",
  postedAt = new Date(),
  categoryId?: number | null,
): Promise<CashResult> {
  const amt = Math.max(0, Math.round(amountCents));
  // Read, insert and rebuild as one unit, so two entries never draw on the same
  // balance: queued within this process, and a write transaction (BEGIN
  // IMMEDIATE) against another process, which then fails busy instead of
  // writing a wrong balance.
  return serializeCash(() => db.transaction(async (tx) => {
    const cash = await getOrCreateCashAccount(tx);
    // The rows are the truth; the stored balance can be stale (see `getCashDrift`).
    // A set lands the rows exactly on the new total even if they summed negative.
    const rowsSum = cashRowsSumCents(await cashRows(cash.id, tx));
    const delta = op === "set" ? amt - rowsSum : op === "add" ? amt : -Math.min(amt, cashOnHand(rowsSum));

    if (delta !== 0) {
      const label =
        note.trim() ||
        (op === "set" ? "Cash balance set" : op === "add" ? "Cash added" : "Cash spent");
      await tx.insert(transactions).values({
        accountId: cash.id,
        externalId: `cash_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        postedAt,
        amountCents: delta,
        merchantRaw: label,
        payeeNormalized: normalizePayee(label),
        note: note.trim() || null,
        categoryId: categoryId ?? null,
        categorySource: categoryId ? "manual" : "uncategorized",
        categoryConfidence: categoryId ? 1 : null,
        source: "manual",
        // a "set" is a balance correction, not income/spending
        isTransfer: op === "set",
      });
    }
    // Rebuild even when nothing changed, so a stale stored balance heals.
    const balanceCents = await rebuildCashBalance(cash.id, tx);

    return { balanceCents, op, amountCents: amt, deltaCents: delta, note };
  }));
}

let cashQueue: Promise<unknown> = Promise.resolve();
/** Run cash writes one at a time in this process; libsql fails a second concurrent write transaction rather than waiting. */
function serializeCash<T>(fn: () => Promise<T>): Promise<T> {
  const run = cashQueue.then(fn, fn);
  cashQueue = run.catch(() => undefined);
  return run;
}

export async function applyCashCommand(text: string): Promise<CashResult> {
  // Both parsers fall through to `set 0` when they find no number, which wipes
  // the running total. "set to 0" still works: it contains a digit.
  if (!/\d/.test(text)) throw new Error("No amount found. Try \"spent 15 on lunch\", \"add 40\", or \"set 200\".");
  const cmd = await parseCashCommand(text);
  return applyCashOp(
    cmd.op,
    cmd.amountCents,
    cmd.note,
    cmd.date ? dateFromInput(cmd.date) : new Date(),
  );
}

export async function getCashActivity(limit = 50) {
  const cash = await getCashAccount();
  if (!cash) return [];
  return db.query.transactions.findMany({
    where: eq(transactions.accountId, cash.id),
    with: { category: true },
    orderBy: (t, { desc }) => [desc(t.postedAt), desc(t.id)],
    limit,
  });
}

export function dateFromInput(date: string): Date {
  const trimmed = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return new Date();
  return new Date(`${trimmed}T12:00:00`);
}

// A split row nets a purchase in spending but moves no cash.
const cashRows = (cashId: number, ex: Executor = db) =>
  ex.query.transactions.findMany({
    where: and(eq(transactions.accountId, cashId), ne(transactions.source, "split")),
    orderBy: (t, { asc }) => [asc(t.postedAt), asc(t.id)],
  });

/** The signed sum of the cash rows. Negative means a spend was logged that no cash-in covers. */
export const cashRowsSumCents = (rows: { amountCents: number }[]) => rows.reduce((sum, t) => sum + t.amountCents, 0);

/** Cash on hand cannot be negative, so a negative row sum is stored as 0 — and `getCashDrift` reports it. */
export const cashOnHand = (rowsSumCents: number) => Math.max(0, rowsSumCents);

export type CashDrift = { storedCents: number; fromRowsCents: number; reconciled: boolean };

/**
 * Stored cash balance vs its rows, read-only, for `fin doctor`. `fromRowsCents`
 * is the raw signed sum; it is reconciled only when the stored balance equals
 * it, so a negative sum is never hidden behind the stored $0.
 */
export async function getCashDrift(): Promise<CashDrift | null> {
  const cash = await getCashAccount();
  if (!cash) return null;
  const fromRowsCents = cashRowsSumCents(await cashRows(cash.id));
  return { storedCents: cash.currentBalanceCents, fromRowsCents, reconciled: cash.currentBalanceCents === fromRowsCents };
}

/** Rewrite the stored cash balance and its snapshots from the rows. */
export async function reconcileCashBalance(): Promise<number | null> {
  const cash = await getCashAccount();
  return cash ? rebuildCashBalance(cash.id) : null;
}

async function rebuildCashBalance(cashId: number, ex: Executor = db) {
  const rows = await cashRows(cashId, ex);
  const next = cashOnHand(cashRowsSumCents(rows));
  await ex
    .update(accounts)
    .set({ currentBalanceCents: next, lastSyncedAt: new Date() })
    .where(eq(accounts.id, cashId));

  await ex.delete(balanceSnapshots).where(eq(balanceSnapshots.accountId, cashId));

  const daily = new Map<string, number>();
  let running = 0;
  for (const row of rows) {
    running += row.amountCents;
    daily.set(isoDate(row.postedAt), Math.max(0, running));
  }

  if (daily.size > 0) {
    for (const [date, balanceCents] of daily) {
      await ex
        .insert(balanceSnapshots)
        .values({ accountId: cashId, date, balanceCents, isAsset: true })
        .onConflictDoUpdate({
          target: [balanceSnapshots.accountId, balanceSnapshots.date],
          set: { balanceCents, isAsset: true },
        });
    }
  } else {
    await ex
      .insert(balanceSnapshots)
      .values({ accountId: cashId, date: isoDate(new Date()), balanceCents: 0, isAsset: true })
      .onConflictDoUpdate({
        target: [balanceSnapshots.accountId, balanceSnapshots.date],
        set: { balanceCents: 0, isAsset: true },
      });
  }

  return Math.max(0, next);
}

export type CashTransactionInput = {
  id?: number;
  direction: "spend" | "add";
  amountCents: number;
  postedAt: Date;
  note: string;
  categoryId?: number | null;
};

export async function createCashTransaction(input: CashTransactionInput) {
  const cash = await getOrCreateCashAccount();
  const amount = Math.max(0, Math.round(input.amountCents));
  const amountCents = input.direction === "spend" ? -amount : amount;
  const label = input.note.trim() || (input.direction === "spend" ? "Cash spent" : "Cash added");
  const [created] = await db
    .insert(transactions)
    .values({
      accountId: cash.id,
      externalId: `cash_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      postedAt: input.postedAt,
      amountCents,
      merchantRaw: label,
      payeeNormalized: normalizePayee(label),
      note: input.note.trim() || null,
      categoryId: input.categoryId ?? null,
      categorySource: input.categoryId ? "manual" : "uncategorized",
      categoryConfidence: input.categoryId ? 1 : null,
      source: "manual",
    })
    .returning();
  const balanceCents = await rebuildCashBalance(cash.id);
  return { transaction: created, balanceCents };
}

export async function updateCashTransaction(input: CashTransactionInput & { id: number }) {
  const cash = await getCashAccount();
  if (!cash) throw new Error("Cash account does not exist");
  const existing = await db.query.transactions.findFirst({
    where: and(eq(transactions.id, input.id), eq(transactions.accountId, cash.id)),
  });
  if (!existing) throw new Error("Cash transaction not found");
  await refuseSplitRow(existing.id);

  const amount = Math.max(0, Math.round(input.amountCents));
  const amountCents = input.direction === "spend" ? -amount : amount;
  const label = input.note.trim() || (input.direction === "spend" ? "Cash spent" : "Cash added");
  await db
    .update(transactions)
    .set({
      postedAt: input.postedAt,
      amountCents,
      merchantRaw: label,
      payeeNormalized: normalizePayee(label),
      note: input.note.trim() || null,
      categoryId: input.categoryId ?? null,
      categorySource: input.categoryId ? "manual" : "uncategorized",
      categoryConfidence: input.categoryId ? 1 : null,
      isTransfer: false,
    })
    .where(eq(transactions.id, input.id));

  const balanceCents = await rebuildCashBalance(cash.id);
  return { balanceCents };
}

export async function deleteCashTransaction(id: number) {
  const cash = await getCashAccount();
  if (!cash) throw new Error("Cash account does not exist");
  const existing = await db.query.transactions.findFirst({
    where: and(eq(transactions.id, id), eq(transactions.accountId, cash.id)),
  });
  if (!existing) throw new Error("Cash transaction not found");
  await refuseSplitRow(existing.id);
  await db.delete(transactions).where(eq(transactions.id, id));
  const balanceCents = await rebuildCashBalance(cash.id);
  return { balanceCents };
}
