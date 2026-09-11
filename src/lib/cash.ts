import { db } from "@/db";
import { accounts, transactions, balanceSnapshots } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { completeStructured, hasAnyProvider } from "@/lib/ai";
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

export async function getCashAccount() {
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.name, CASH_NAME), eq(accounts.source, "manual")))
    .get();
}

async function getOrCreateCashAccount() {
  const existing = await getCashAccount();
  if (existing) return existing;
  const [created] = await db
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

export async function parseCashCommand(text: string): Promise<CashCommand> {
  if (!hasAnyProvider()) return parseCashText(text);
  try {
    const p = await completeStructured({
      system:
        "Interpret a short message about the user's physical cash on hand. Decide whether it SETs the running total to an amount, ADDs to it, or SUBTRACTs from it; the dollar amount; a brief note (e.g. what it was spent on); and the calendar date if mentioned. Return date as YYYY-MM-DD, or an empty string if no date is mentioned. Examples: 'I have $200 in my wallet' -> set, 200. 'spent 15 on lunch yesterday' -> subtract, 15, note 'lunch', date yesterday in YYYY-MM-DD. 'add 50' -> add, 50. 'found a $20 bill' -> add, 20, note 'found bill'.",
      messages: [{ role: "user", content: text }],
      maxTokens: 256,
      schema: { name: "cash_command", schema: CASH_SCHEMA },
      parse: (raw) => CashParse.parse(raw),
      // Without this a stalled provider hangs the caller indefinitely.
      signal: AbortSignal.timeout(CASH_PARSE_TIMEOUT_MS),
    });
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
  const cash = await getOrCreateCashAccount();
  const cur = cash.currentBalanceCents;

  let next: number;
  if (op === "set") next = amt;
  else if (op === "add") next = cur + amt;
  else next = Math.max(0, cur - amt);
  const delta = next - cur;

  await db
    .update(accounts)
    .set({ currentBalanceCents: next, lastSyncedAt: new Date() })
    .where(eq(accounts.id, cash.id));

  await db
    .insert(balanceSnapshots)
    .values({ accountId: cash.id, date: isoDate(new Date()), balanceCents: next, isAsset: true })
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: { balanceCents: next, isAsset: true },
    });

  if (delta !== 0) {
    const label =
      note.trim() ||
      (op === "set" ? "Cash balance set" : op === "add" ? "Cash added" : "Cash spent");
    await db.insert(transactions).values({
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
    await rebuildCashBalance(cash.id);
  }

  return { balanceCents: next, op, amountCents: amt, deltaCents: delta, note };
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

async function rebuildCashBalance(cashId: number) {
  const rows = await db.query.transactions.findMany({
    where: eq(transactions.accountId, cashId),
    orderBy: (t, { asc }) => [asc(t.postedAt), asc(t.id)],
  });
  const next = rows.reduce((sum, t) => sum + t.amountCents, 0);
  await db
    .update(accounts)
    .set({ currentBalanceCents: Math.max(0, next), lastSyncedAt: new Date() })
    .where(eq(accounts.id, cashId));

  await db.delete(balanceSnapshots).where(eq(balanceSnapshots.accountId, cashId));

  const daily = new Map<string, number>();
  let running = 0;
  for (const row of rows) {
    running += row.amountCents;
    daily.set(isoDate(row.postedAt), Math.max(0, running));
  }

  if (daily.size > 0) {
    for (const [date, balanceCents] of daily) {
      await db
        .insert(balanceSnapshots)
        .values({ accountId: cashId, date, balanceCents, isAsset: true })
        .onConflictDoUpdate({
          target: [balanceSnapshots.accountId, balanceSnapshots.date],
          set: { balanceCents, isAsset: true },
        });
    }
  } else {
    await db
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
  await db.delete(transactions).where(eq(transactions.id, id));
  const balanceCents = await rebuildCashBalance(cash.id);
  return { balanceCents };
}
