/**
 * Categorise what a sync just brought in, so new rows land filed. Runs after
 * every sync; it can never fail one.
 *
 *   AUTO_CATEGORIZE=ai     rules, history and built-ins, then the AI (default when a provider key exists)
 *   AUTO_CATEGORIZE=rules  deterministic layers only, nothing leaves the machine (default without a key)
 *   AUTO_CATEGORIZE=off    do nothing
 *
 * The env var wins; otherwise app_config `auto_categorize` holds the same values.
 * Only rows without a category are touched, so a manual choice is never overwritten.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { hasAnyProvider } from "@/lib/ai";
import { appendRunLog, categorizeUncategorized, type CategorizeSummary } from "@/lib/categorize";
import { detectTransfers } from "@/lib/transfers";

export const AUTO_MODES = ["ai", "rules", "off"] as const;
export type AutoMode = (typeof AUTO_MODES)[number];

/** Per sync: rows sent to the provider, and the wall clock for the whole step. */
export const AUTO_MAX_AI = 100;
export const AUTO_TIMEOUT_MS = 300_000;

export type AutoResult =
  | { mode: "off" }
  | { mode: Exclude<AutoMode, "off">; summary: CategorizeSummary }
  | { mode: AutoMode; error: string };

export async function autoMode(): Promise<AutoMode> {
  const pick = (v: string | null | undefined) => (AUTO_MODES as readonly string[]).includes(v?.trim().toLowerCase() ?? "") ? (v!.trim().toLowerCase() as AutoMode) : null;
  const env = pick(process.env.AUTO_CATEGORIZE);
  const stored = env ? null : pick((await db.select().from(appConfig).where(eq(appConfig.key, "auto_categorize")).get())?.value);
  const mode = env ?? stored ?? "ai";
  return mode === "ai" && !hasAnyProvider() ? "rules" : mode;
}

type Deps = {
  run: typeof categorizeUncategorized;
  transfers: typeof detectTransfers;
  log: (line: string) => void;
};

/** Never throws: a failure is logged as one line and returned. */
export async function autoCategorize(deps: Partial<Deps> = {}): Promise<AutoResult> {
  const { run = categorizeUncategorized, transfers = detectTransfers, log = (l: string) => console.warn(l) } = deps;
  let mode: AutoMode = "rules";
  try {
    mode = await autoMode();
    if (mode === "off") return { mode };
    await transfers();
    const summary = await run({
      noAI: mode === "rules",
      maxAI: AUTO_MAX_AI,
      signal: AbortSignal.timeout(AUTO_TIMEOUT_MS),
      trigger: "sync",
    });
    return { mode, summary };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    log(`auto-categorize failed (${mode}): ${error}`);
    await appendRunLog({ at: new Date().toISOString(), trigger: "sync", total: 0, left: 0, byRule: 0, byHistory: 0, byBuiltin: 0, byCache: 0, byAI: 0, skipped: error }).catch(() => {});
    return { mode, error };
  }
}

/** One line for the sync log. */
export function autoLine(r: AutoResult): string {
  if ("error" in r) return `auto-categorize failed: ${r.error}`;
  if (r.mode === "off") return "auto-categorize: off";
  const s = r.summary;
  if (!s.total) return "auto-categorize: nothing new";
  return `auto-categorize (${r.mode}): ${s.categorized} of ${s.total} — ${s.byRule} rule, ${s.byHistory} history, ${s.byBuiltin} built-in, ${s.byCache} cache, ${s.byAI} AI; ${s.left} left${s.aiError ? ` (AI: ${s.aiError})` : ""}`;
}
