/**
 * CLI sync — wire this to launchd/cron to refresh accounts on a schedule.
 *   bun run sync
 */
// The lib shares `server-only` modules with the app; they load only under the
// react-server condition (as `bin/fin` runs). Started plainly, re-run with it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!import.meta.resolve("server-only").endsWith("empty.js")) {
  const r = spawnSync(process.execPath, ["--conditions", "react-server", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { syncSimplefin } = await import("../src/lib/ingest/sync");
const { autoLine } = await import("../src/lib/categorize-auto");

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
  console.log(`  ${r.autoCategorize === "deferred" ? "categorizing after sync" : autoLine(r.autoCategorize)}`);
  process.exit(0);
} catch (e) {
  console.error("✗ sync failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
