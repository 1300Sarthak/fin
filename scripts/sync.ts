/**
 * CLI sync — wire this to launchd/cron to refresh accounts on a schedule.
 *   bun run sync
 */
import { syncSimplefin } from "../src/lib/ingest/sync";

try {
  const r = await syncSimplefin();
  console.log(
    `✓ synced ${r.accounts} accounts — ${r.newTransactions} new txns, ${r.updatedTransactions} updated`,
  );
  if (r.newAccounts) console.log(`  + ${r.newAccounts} new account(s)`);
  if (r.adoptedAccounts) {
    console.log(
      `  ↻ ${r.adoptedAccounts} account(s) re-matched after an upstream reconnect`,
    );
  }
  if (r.errors.length) console.warn("⚠ provider errors:", r.errors);
  process.exit(0);
} catch (e) {
  console.error("✗ sync failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
