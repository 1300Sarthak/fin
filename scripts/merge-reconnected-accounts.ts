/**
 * Merge duplicate accounts left behind when a provider connection is re-added.
 *   bun run scripts/merge-reconnected-accounts.ts          # show the plan, change nothing
 *   bun run scripts/merge-reconnected-accounts.ts --apply  # perform the merge
 *
 * Re-adding a connection at SimpleFIN mints brand-new account ids for the same
 * real accounts, so `upsertAccount` — which keys on `externalId` — inserts a
 * second row instead of matching the first. The result is every balance counted
 * twice in net worth.
 *
 * The ORIGINAL row wins: it carries the deeper transaction history plus every
 * goal link, milestone line, and snapshot pointing at its id. It adopts the new
 * `externalId` so future syncs match it, and takes the newer row's balance. The
 * duplicate and its re-issued transactions are dropped — the provider re-mints
 * transaction ids too, so those rows are the same real activity under new ids.
 *
 * Duplicates are matched on (institutionId, name, type); the oldest row in a
 * group survives. Anything unmatched — a genuinely new account, like a card
 * that appeared after reconnecting — is left completely alone.
 */
import { db } from "../src/db";
import { accounts, transactions, balanceSnapshots } from "../src/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isoDate } from "../src/lib/format";

const apply = process.argv.includes("--apply");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

type Row = typeof accounts.$inferSelect;

const all = await db.select().from(accounts);

// Group by the identity a provider keeps stable across a reconnect.
const groups = new Map<string, Row[]>();
for (const a of all) {
  if (!a.externalId) continue; // manual accounts have no provider identity
  const key = `${a.institutionId ?? 0}|${a.name}|${a.type}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
}

const dupes = [...groups.values()].filter((g) => g.length > 1);

if (dupes.length === 0) {
  console.log("No duplicate accounts found — nothing to merge.");
  process.exit(0);
}

const today = isoDate(new Date());
let mergedCount = 0;

for (const group of dupes) {
  const sorted = [...group].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const keep = sorted[0];
  const drop = sorted.slice(1);
  // The newest row holds the figure the provider reported most recently.
  const fresh = sorted[sorted.length - 1];
  const dropIds = drop.map((d) => d.id);

  const txnCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(inArray(transactions.accountId, dropIds))
    .get();
  const snapCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, dropIds))
    .get();

  console.log(`\n${keep.name}`);
  console.log(`  keep  #${keep.id}  ${usd(keep.currentBalanceCents)}`);
  for (const d of drop) {
    console.log(`  drop  #${d.id}  ${usd(d.currentBalanceCents)}`);
  }
  console.log(
    `  → #${keep.id} adopts externalId ${fresh.externalId}, balance ${usd(keep.currentBalanceCents)} → ${usd(fresh.currentBalanceCents)}`,
  );
  console.log(
    `  → discards ${txnCount?.n ?? 0} re-issued transactions, ${snapCount?.n ?? 0} snapshots`,
  );

  if (!apply) continue;

  // Children first, then the row, so the unique externalId is free to reassign.
  await db.delete(transactions).where(inArray(transactions.accountId, dropIds));
  await db
    .delete(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, dropIds));
  await db.delete(accounts).where(inArray(accounts.id, dropIds));

  await db
    .update(accounts)
    .set({
      externalId: fresh.externalId,
      currentBalanceCents: fresh.currentBalanceCents,
      availableBalanceCents: fresh.availableBalanceCents,
      balanceDate: fresh.balanceDate,
      lastSyncedAt: fresh.lastSyncedAt,
    })
    .where(eq(accounts.id, keep.id));

  // Today's snapshot still holds the pre-merge figure.
  await db
    .update(balanceSnapshots)
    .set({ balanceCents: fresh.currentBalanceCents })
    .where(
      and(
        eq(balanceSnapshots.accountId, keep.id),
        eq(balanceSnapshots.date, today),
      ),
    );

  mergedCount += 1;
}

if (!apply) {
  console.log(
    `\n${dupes.length} duplicate group(s). Re-run with --apply to merge.`,
  );
} else {
  console.log(`\n✓ merged ${mergedCount} duplicate group(s).`);
}
process.exit(0);
