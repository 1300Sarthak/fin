import { db } from "@/db";
import {
  institutions,
  accounts,
  transactions,
  balanceSnapshots,
  type AccountType,
  holdings,
} from "@/db/schema";
import { and, eq, gte, inArray, isNotNull, ne, notInArray } from "drizzle-orm";
import { ACCOUNT_TYPE_META } from "@/lib/accounts";
import { isoDate } from "@/lib/format";
import { chunk } from "@/lib/normalize";
import { keepSplitShares } from "@/lib/assistant/split-sync";

/* ------------------------------ normalized shapes ----------------------------- */

export type NormalizedTransaction = {
  externalId: string;
  postedAt: Date;
  amountCents: number; // signed; negative = outflow (spending)
  merchantRaw: string;
  payeeNormalized: string;
  memo?: string | null;
  isPending?: boolean;
};

export type NormalizedAccount = {
  externalId: string;
  name: string;
  type: AccountType;
  currency: string;
  /** Normalized: positive for assets; amount-owed (positive) for liabilities. */
  balanceCents: number;
  availableBalanceCents?: number | null;
  balanceDate: Date;
  institution: {
    externalId?: string | null;
    name: string;
    domain?: string | null;
  };
  transactions: NormalizedTransaction[];
  /** Security positions, when the provider reports them (investment accounts). */
  holdings?: NormalizedHolding[];
};

export type NormalizedHolding = {
  externalId: string;
  symbol: string | null;
  description: string | null;
  shares: number;
  marketValueCents: number;
  costPerShareCents: number | null;
  currency: string;
  asOf: Date;
};

export type IngestSource = "simplefin" | "csv" | "manual";

export type IngestSummary = {
  accounts: number;
  newAccounts: number;
  /** Existing rows re-matched after a connection was re-added upstream. */
  adoptedAccounts: number;
  newTransactions: number;
  updatedTransactions: number;
};

/* --------------------------------- upserts ----------------------------------- */

async function upsertInstitution(
  inst: NormalizedAccount["institution"],
): Promise<number> {
  if (inst.externalId) {
    const existing = await db
      .select()
      .from(institutions)
      .where(eq(institutions.simplefinOrgId, inst.externalId))
      .get();
    if (existing) return existing.id;
    const [created] = await db
      .insert(institutions)
      .values({
        name: inst.name,
        simplefinOrgId: inst.externalId,
        domain: inst.domain ?? null,
      })
      .returning();
    return created.id;
  }
  const existing = await db
    .select()
    .from(institutions)
    .where(eq(institutions.name, inst.name))
    .get();
  if (existing) return existing.id;
  const [created] = await db
    .insert(institutions)
    .values({ name: inst.name, domain: inst.domain ?? null })
    .returning();
  return created.id;
}

/**
 * Find the row a provider account belongs to when its `externalId` is unknown.
 *
 * Re-adding a connection mints fresh ids for accounts that already exist here,
 * so matching on `externalId` alone would insert a second row and double-count
 * the balance. Fall back to the identity a provider does keep stable across a
 * reconnect — institution, name, type — but only adopt a row the provider has
 * stopped reporting under its old id (absent from `seenExternalIds`) and only
 * when exactly one candidate fits. A name that matches a still-reported account
 * is a genuine sibling, not a reconnect, so it must not be adopted.
 */
async function findReconnectedRow(
  acc: NormalizedAccount,
  institutionId: number,
  source: IngestSource,
  seenExternalIds: Set<string>,
) {
  const seen = [...seenExternalIds];
  if (seen.length === 0) return null;
  const candidates = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.institutionId, institutionId),
        eq(accounts.name, acc.name),
        eq(accounts.type, acc.type),
        eq(accounts.source, source),
        isNotNull(accounts.externalId),
        notInArray(accounts.externalId, seen),
      ),
    );
  return candidates.length === 1 ? candidates[0] : null;
}

async function upsertAccount(
  acc: NormalizedAccount,
  institutionId: number,
  source: IngestSource,
  seenExternalIds: Set<string>,
): Promise<{ id: number; isNew: boolean; adopted: boolean }> {
  const isAsset = ACCOUNT_TYPE_META[acc.type].isAsset;
  const byExternalId = await db
    .select()
    .from(accounts)
    .where(eq(accounts.externalId, acc.externalId))
    .get();
  const reconnected = byExternalId
    ? null
    : await findReconnectedRow(acc, institutionId, source, seenExternalIds);
  const existing = byExternalId ?? reconnected;

  const common = {
    name: acc.name,
    type: acc.type,
    currency: acc.currency,
    currentBalanceCents: acc.balanceCents,
    availableBalanceCents: acc.availableBalanceCents ?? null,
    isAsset,
    institutionId,
    // The provider's own timestamp for this balance. Kept distinct from
    // `lastSyncedAt` (when we last asked) so a connection that keeps answering
    // with a frozen figure is visible instead of reading as fresh.
    balanceDate: Number.isFinite(acc.balanceDate?.getTime())
      ? acc.balanceDate
      : null,
    lastSyncedAt: new Date(),
  };

  if (existing) {
    await db
      .update(accounts)
      // An adopted row still carries the provider's old id; take the new one so
      // the next sync matches on `externalId` again.
      .set(reconnected ? { ...common, externalId: acc.externalId } : common)
      .where(eq(accounts.id, existing.id));
    return { id: existing.id, isNew: false, adopted: Boolean(reconnected) };
  }
  const [created] = await db
    .insert(accounts)
    .values({ externalId: acc.externalId, source, ...common })
    .returning();
  return { id: created.id, isNew: true, adopted: false };
}

async function upsertTransactions(
  accountId: number,
  txns: NormalizedTransaction[],
  source: IngestSource,
): Promise<{ inserted: number; updated: number }> {
  if (txns.length === 0) return { inserted: 0, updated: 0 };

  // Which externalIds already exist on this account?
  const existing = new Set<string>();
  for (const ids of chunk(
    txns.map((t) => t.externalId),
    400,
  )) {
    const rows = await db
      .select({ externalId: transactions.externalId })
      .from(transactions)
      .where(
        and(eq(transactions.accountId, accountId), inArray(transactions.externalId, ids)),
      );
    for (const r of rows) if (r.externalId) existing.add(r.externalId);
  }

  const toInsert = txns.filter((t) => !existing.has(t.externalId));
  const toUpdate = txns.filter((t) => existing.has(t.externalId));

  /*
   * A provider that re-mints account ids re-mints transaction ids with them, so
   * after a reconnect it re-sends activity we already hold under ids it will
   * never mention again. Inserting those would double every purchase in the
   * window. Pair them by content instead — same instant, same amount, same
   * payee — against rows this payload never claimed, and move the new id onto
   * the row we already have. User work on that row (category, note, refund
   * link) is untouched, and the next sync matches on `externalId` again.
   *
   * Pairing is one-to-one and pool-drained, so two genuinely identical charges
   * on one day still end up as two rows.
   */
  const claimed = new Set(txns.map((t) => t.externalId));
  // Keyed on instant + amount only. A provider that re-issues an id often
  // rewords the description with it ("Buy X Shares of…" -> "Buy Shares of…"),
  // and a pending charge is frequently reworded as it posts, so the payee is
  // used to choose between candidates rather than to find them.
  const contentKey = (postedAt: Date, amountCents: number): string =>
    `${postedAt.getTime()}|${amountCents}`;

  const reissued: { id: number; txn: NormalizedTransaction }[] = [];
  const genuinelyNew: NormalizedTransaction[] = [];

  if (toInsert.length > 0) {
    const earliest = new Date(
      Math.min(...toInsert.map((t) => t.postedAt.getTime())),
    );
    const candidates = await db
      .select({
        id: transactions.id,
        externalId: transactions.externalId,
        postedAt: transactions.postedAt,
        amountCents: transactions.amountCents,
        payeeNormalized: transactions.payeeNormalized,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          gte(transactions.postedAt, earliest),
          // Assistant-made split rows have no provider id; never adopt one.
          ne(transactions.source, "split"),
        ),
      );

    const pool = new Map<string, typeof candidates>();
    for (const c of candidates) {
      // A row this payload still reports is live, not a leftover id.
      if (c.externalId && claimed.has(c.externalId)) continue;
      const k = contentKey(c.postedAt, c.amountCents);
      const bucket = pool.get(k);
      if (bucket) bucket.push(c);
      else pool.set(k, [c]);
    }
    // Oldest row first, so the original (the one carrying any user edits) is
    // the one that gets adopted rather than a later copy.
    for (const bucket of pool.values()) bucket.sort((a, b) => a.id - b.id);

    for (const t of toInsert) {
      const bucket = pool.get(contentKey(t.postedAt, t.amountCents));
      if (!bucket || bucket.length === 0) {
        genuinelyNew.push(t);
        continue;
      }
      // Same wording wins; otherwise the oldest candidate.
      const exact = bucket.findIndex(
        (c) => c.payeeNormalized === t.payeeNormalized,
      );
      const [match] = bucket.splice(exact >= 0 ? exact : 0, 1);
      reissued.push({ id: match.id, txn: t });
    }
  }

  for (const { id, txn } of reissued) {
    await db
      .update(transactions)
      .set({
        externalId: txn.externalId,
        postedAt: txn.postedAt,
        amountCents: txn.amountCents,
        isPending: txn.isPending ?? false,
        merchantRaw: txn.merchantRaw,
        payeeNormalized: txn.payeeNormalized,
        memo: txn.memo ?? null,
      })
      .where(eq(transactions.id, id));
  }

  for (const batch of chunk(genuinelyNew, 100)) {
    await db
      .insert(transactions)
      .values(
        batch.map((t) => ({
          accountId,
          externalId: t.externalId,
          postedAt: t.postedAt,
          amountCents: t.amountCents,
          merchantRaw: t.merchantRaw,
          payeeNormalized: t.payeeNormalized,
          memo: t.memo ?? null,
          isPending: t.isPending ?? false,
          source,
        })),
      )
      .onConflictDoNothing();
  }

  // Refresh existing rows (e.g. pending -> posted, amount finalized).
  for (const t of toUpdate) {
    await db
      .update(transactions)
      .set({
        amountCents: t.amountCents,
        isPending: t.isPending ?? false,
        postedAt: t.postedAt,
        merchantRaw: t.merchantRaw,
        payeeNormalized: t.payeeNormalized,
        memo: t.memo ?? null,
      })
      .where(
        and(
          eq(transactions.accountId, accountId),
          eq(transactions.externalId, t.externalId),
        ),
      );
  }

  await keepSplitShares(accountId);

  return {
    inserted: genuinelyNew.length,
    updated: toUpdate.length + reissued.length,
  };
}

async function writeSnapshot(accountId: number, acc: NormalizedAccount) {
  const date = isoDate(new Date());
  await db
    .insert(balanceSnapshots)
    .values({
      accountId,
      date,
      balanceCents: acc.balanceCents,
      isAsset: ACCOUNT_TYPE_META[acc.type].isAsset,
    })
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: {
        balanceCents: acc.balanceCents,
        isAsset: ACCOUNT_TYPE_META[acc.type].isAsset,
      },
    });
}

/**
 * Ingest a set of normalized accounts (from any adapter): upserts institutions,
 * accounts, transactions, and writes a daily balance snapshot per account.
 */
/**
 * Positions are a snapshot, so the account's rows are replaced rather than
 * merged: a sold-out position must disappear, and an upsert would leave it
 * behind forever. `undefined` means the provider said nothing about this
 * account (a checking account, or a failed partial sync) — leave it alone. An
 * empty array is a real answer: the account holds nothing.
 */
async function replaceHoldings(
  accountId: number,
  rows: NormalizedHolding[] | undefined,
): Promise<void> {
  if (!rows) return;
  await db.delete(holdings).where(eq(holdings.accountId, accountId));
  if (!rows.length) return;
  await db.insert(holdings).values(
    rows.map((h) => ({
      accountId,
      externalId: h.externalId,
      symbol: h.symbol,
      description: h.description,
      shares: h.shares,
      marketValueCents: h.marketValueCents,
      costPerShareCents: h.costPerShareCents,
      currency: h.currency,
      asOf: h.asOf,
    })),
  );
}

export async function ingestAccounts(
  data: NormalizedAccount[],
  source: IngestSource,
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    accounts: 0,
    newAccounts: 0,
    adoptedAccounts: 0,
    newTransactions: 0,
    updatedTransactions: 0,
  };

  // Every id this payload reports. An account we hold that is missing from it
  // is the tell-tale of a reconnect, and the only kind we let a name match.
  const seenExternalIds = new Set(data.map((d) => d.externalId));

  for (const acc of data) {
    const institutionId = await upsertInstitution(acc.institution);
    const { id: accountId, isNew, adopted } = await upsertAccount(
      acc,
      institutionId,
      source,
      seenExternalIds,
    );
    const { inserted, updated } = await upsertTransactions(
      accountId,
      acc.transactions,
      source,
    );
    await writeSnapshot(accountId, acc);
    await replaceHoldings(accountId, acc.holdings);

    summary.accounts += 1;
    if (isNew) summary.newAccounts += 1;
    if (adopted) summary.adoptedAccounts += 1;
    summary.newTransactions += inserted;
    summary.updatedTransactions += updated;
  }

  return summary;
}

/** Add CSV-imported transactions to an existing account (backfill / fallback). */
export async function ingestCsvTransactions(
  accountId: number,
  txns: NormalizedTransaction[],
): Promise<{ inserted: number; updated: number }> {
  return upsertTransactions(accountId, txns, "csv");
}
