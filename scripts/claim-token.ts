/**
 * Claim a SimpleFIN setup token and SAVE the resulting access URL into the app
 * (so the one-time claim is never wasted). After this, just `bun run sync`.
 *   bun run scripts/claim-token.ts <SETUP_TOKEN>
 * Pass "demo" to print the reusable SimpleFIN demo access URL.
 *
 * You don't strictly need this — pasting the token into SIMPLEFIN_ACCESS_URL and
 * running `bun run sync` claims + saves it automatically.
 */
import {
  claimSetupToken,
  SIMPLEFIN_DEMO_ACCESS_URL,
} from "../src/lib/ingest/simplefin";
import { saveResolvedAccessUrl } from "../src/lib/ingest/sync";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: bun run scripts/claim-token.ts <SETUP_TOKEN | demo>");
  process.exit(1);
}

if (arg === "demo") {
  console.log("\nAdd this to .env.local (public demo dataset):\n");
  console.log(`SIMPLEFIN_ACCESS_URL=${SIMPLEFIN_DEMO_ACCESS_URL}\n`);
  process.exit(0);
}

try {
  const accessUrl = await claimSetupToken(arg);
  await saveResolvedAccessUrl(accessUrl, arg);
  console.log("\n✓ Claimed and saved your SimpleFIN connection.");
  console.log("  Run `bun run sync` (or click Sync now) to pull your accounts.\n");
  console.log("  Back this up (setup tokens are single-use):");
  console.log(`  ${accessUrl}\n`);
  process.exit(0);
} catch (e) {
  console.error("✗ claim failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
