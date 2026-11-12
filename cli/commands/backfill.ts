import { bool, isoDay, num, str, type Args } from "../args";
import { emit } from "../render";
import { runBackfill } from "@/lib/ingest/backfill";

/**
 * `fin sync --backfill --since 2025-01-01 [--until D] [--max-requests N] [--dry-run]`
 * Older SimpleFIN history, 45 days per request, newest first. `--dry-run`
 * prints the windows and contacts nothing.
 */
export async function syncBackfill(a: Args, json: boolean) {
  const sinceRaw = str(a, "since");
  if (!sinceRaw) throw new Error("--backfill needs --since YYYY-MM-DD (how far back to ask for)");
  const since = isoDay(sinceRaw, "--since");
  const untilRaw = str(a, "until");
  const r = await runBackfill({
    since,
    until: untilRaw ? isoDay(untilRaw, "--until") : undefined,
    maxRequests: num(a, "max-requests", { min: 1, max: 24 }),
    dryRun: bool(a, "dry-run"),
  });
  emit(json, r, () =>
    [
      `  ${r.dryRun ? "would request" : "requested"} ${r.windows.length} window(s), ${r.since} … ${r.until}${r.dryRun ? " — nothing sent" : ""}`,
      ...r.windows.map((w) => `  ${w.start} → ${w.end}${r.dryRun ? "" : `  ${w.returned} returned, ${w.inserted} new, ${w.updated} updated${w.errors.length ? `  (${w.errors.join("; ")})` : ""}`}`),
      r.stoppedEarly ? `  stopped: ${r.stoppedEarly}` : "",
      r.dryRun ? "" : "  run `fin sync --full` afterwards so transfers, refunds and categories cover the new rows",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
