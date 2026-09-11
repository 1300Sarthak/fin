/**
 * Repair transactions duplicated by a provider re-minting its ids.
 *   bun run scripts/dedupe-reissued-transactions.ts          # show the plan
 *   bun run scripts/dedupe-reissued-transactions.ts --apply  # perform the repair
 *
 * When a connection is re-added upstream, the provider re-sends activity we
 * already hold under ids it will never mention again, so the ledger ends up
 * with two rows for one real purchase.
 *
 * Which row is the leftover is decided against the provider's CURRENT payload,
 * never guessed from timestamps: a local row whose `externalId` the provider no
 * longer offers is the original, and a row carrying a live id with identical
 * content is its re-issued copy. The original survives — it holds the category,
 * note, refund link, and transfer pairing — and takes over the live id. The
 * copy is deleted. Pairing is one-to-one, so two genuinely identical charges on
 * one day stay two rows.
 *
 * `src/lib/ingest/adapter.ts` does this during sync; this script repairs a
 * ledger that was already doubled before that landed.
 */
import { db } from "../src/db";
import { accounts, transactions } from "../src/db/schema";
import { and, eq, gte } from "drizzle-orm";
import { resolveAccessUrl } from "../src/lib/ingest/sync";
import { fetchSimplefin } from "../src/lib/ingest/simplefin";

const apply = process.argv.includes("--apply");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

const SYNC_WINDOW_DAYS = 89;
const startOfToday = new Date();
startOfToday.setUTCHours(0, 0, 0, 0);
const windowStart = new Date(
  startOfToday.getTime() - SYNC_WINDOW_DAYS * 86400 * 1000,
);

const url = await resolveAccessUrl();
const resp = await fetchSimplefin(url, {
  startDate: Math.floor(windowStart.getTime() / 1000),
  pending: true,
});

// Provider account id -> the transaction ids it currently reports.
const liveIdsByAccount = new Map<string, Set<string>>();
for (const a of resp.accounts ?? []) {
  liveIdsByAccount.set(
    a.id,
    new Set((a.transactions ?? []).map((t) => t.id)),
  );
}

const locals = await db.select().from(accounts);
let pairs = 0;

for (const acct of locals) {
  if (!acct.externalId) continue;
  const live = liveIdsByAccount.get(acct.externalId);
  if (!live || live.size === 0) continue;

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, acct.id),
        gte(transactions.postedAt, windowStart),
      ),
    );

  // Keyed on instant + amount only: a re-issue is usually reworded alongside
  // its new id, so the payee picks between candidates rather than finding them.
  const key = (r: (typeof rows)[number]) =>
    `${r.postedAt.getTime()}|${r.amountCents}`;

  // Rows the provider has stopped reporting: the originals of any re-issue.
  const orphans = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.externalId && live.has(r.externalId)) continue;
    const bucket = orphans.get(key(r));
    if (bucket) bucket.push(r);
    else orphans.set(key(r), [r]);
  }
  // Oldest first — that is the row carrying any user edits.
  for (const bucket of orphans.values()) bucket.sort((a, b) => a.id - b.id);

  const planned: string[] = [];
  for (const r of rows) {
    if (!r.externalId || !live.has(r.externalId)) continue; // not a live copy
    const bucket = orphans.get(key(r));
    if (!bucket || bucket.length === 0) continue;
    const exact = bucket.findIndex(
      (c) => c.payeeNormalized === r.payeeNormalized,
    );
    const [original] = bucket.splice(exact >= 0 ? exact : 0, 1);
    if (!original) continue;

    planned.push(
      `  ${day(r.postedAt)}  ${usd(r.amountCents).padStart(12)}  ${r.merchantRaw.slice(0, 32)}` +
        `\n      keep #${original.id} (adopts ${r.externalId})   delete #${r.id}`,
    );
    pairs += 1;

    if (!apply) continue;
    await db.delete(transactions).where(eq(transactions.id, r.id));
    // Take the live copy's provider-side fields too, so a row kept from the
    // pending stage stops reading as pending and carries the final wording.
    await db
      .update(transactions)
      .set({
        externalId: r.externalId,
        postedAt: r.postedAt,
        amountCents: r.amountCents,
        isPending: r.isPending,
        merchantRaw: r.merchantRaw,
        payeeNormalized: r.payeeNormalized,
        memo: r.memo,
      })
      .where(eq(transactions.id, original.id));
  }

  if (planned.length) {
    console.log(`\n${acct.name} — ${planned.length} re-issued duplicate(s)`);
    console.log(planned.join("\n"));
  }
}

if (pairs === 0) {
  console.log("No re-issued duplicates found.");
} else if (apply) {
  console.log(`\n✓ repaired ${pairs} duplicate pair(s).`);
} else {
  console.log(`\n${pairs} duplicate pair(s). Re-run with --apply to repair.`);
}
process.exit(0);
