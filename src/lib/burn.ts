/**
 * Database loader for the earned / spent / burn-rate engine. The rules live in
 * `burn-core.ts`; this file only fetches rows and stitches the report together.
 */
import { db } from "@/db";
import { transactions, accounts, categories } from "@/db/schema";
import { and, gte, lte, eq, asc } from "drizzle-orm";
import { monthRange } from "@/lib/spending";
import {
  PAIR_WINDOW_DAYS,
  buildReport,
  type BurnReport,
  type Raw,
} from "@/lib/burn-core";

export * from "@/lib/burn-core";

async function loadRows(start: Date, end: Date): Promise<Raw[]> {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      postedAt: transactions.postedAt,
      amountCents: transactions.amountCents,
      merchantRaw: transactions.merchantRaw,
      isTransfer: transactions.isTransfer,
      isRefund: transactions.isRefund,
      isExcluded: transactions.isExcluded,
      account: accounts.name,
      accountType: accounts.type,
      isAsset: accounts.isAsset,
      category: categories.name,
      categoryKind: categories.kind,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(gte(transactions.postedAt, start), lte(transactions.postedAt, end)))
    .orderBy(asc(transactions.postedAt), asc(transactions.id));
  return rows as Raw[];
}


/**
 * Build the flow report for an inclusive month range, e.g. ("2026-06",
 * "2026-08"). Pairing reaches PAIR_WINDOW_DAYS past both edges so a transfer
 * that straddles a month boundary still finds its counterpart.
 */
export async function getBurnReport(from: string, to = from): Promise<BurnReport> {
  const first = monthRange(from);
  const last = monthRange(to);
  const margin = PAIR_WINDOW_DAYS * 86_400_000;
  const raw = await loadRows(
    new Date(first.start.getTime() - margin),
    new Date(last.end.getTime() + margin),
  );
  return buildReport(raw, first.start, last.end, from);
}
