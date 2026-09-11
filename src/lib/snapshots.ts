import { db } from "@/db";
import { accounts, balanceSnapshots } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { isoDate } from "@/lib/format";

/**
 * Upsert today's balance snapshot for every active account. Idempotent via the
 * unique (accountId, date) constraint, so it's safe to call on every page load —
 * each call refreshes today's row to the current balance. Snapshots store the
 * true balance, making them the authoritative source for net-worth history
 * (they sidestep the transaction-reconstruction transfer wart).
 */
export async function captureSnapshotsForToday(): Promise<void> {
  const date = isoDate(new Date());
  const rows = await db
    .select({
      id: accounts.id,
      bal: accounts.currentBalanceCents,
      isAsset: accounts.isAsset,
    })
    .from(accounts)
    .where(eq(accounts.isActive, true));
  if (rows.length === 0) return;

  await db
    .insert(balanceSnapshots)
    .values(
      rows.map((r) => ({
        accountId: r.id,
        date,
        balanceCents: r.bal,
        isAsset: r.isAsset,
      })),
    )
    .onConflictDoUpdate({
      target: [balanceSnapshots.accountId, balanceSnapshots.date],
      set: {
        balanceCents: sql`excluded."balanceCents"`,
        isAsset: sql`excluded."isAsset"`,
      },
    });
}
