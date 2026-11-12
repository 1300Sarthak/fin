/**
 * Imported first by every seed, before anything opens the database:
 * - refuses to run without an explicit DATABASE_URL, or against the repo's own
 *   finance.db, so a seed never lands in a database by default;
 * - re-runs the seed under the react-server condition when started plainly,
 *   because the lib's `server-only` modules load only under it (as in sync.ts).
 */
import { spawnSync } from "node:child_process";

const url = process.env.DATABASE_URL;
if (!url || /^(file:)?(\.\/)?finance\.db$/.test(url)) {
  console.error("seed: set DATABASE_URL to the database to seed (refusing to default to finance.db)");
  process.exit(1);
}
if (!import.meta.resolve("server-only").endsWith("empty.js")) {
  const r = spawnSync(process.execPath, ["--conditions", "react-server", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
