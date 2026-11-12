import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  fetchSimplefin,
  simplefinToNormalized,
  claimSetupToken,
  isAccessUrl,
} from "./simplefin";
import { ingestAccounts, type IngestSummary } from "./adapter";
import { autoCategorize, type AutoResult } from "@/lib/categorize-auto";

/** Thrown for expected, user-actionable problems (e.g. missing/used token). */
export class SyncError extends Error {}

const ACCESS_KEY = "simplefin_access_url";
const SOURCE_KEY = "simplefin_source_token"; // which token produced the cached URL

async function getConfigValue(key: string): Promise<string | null> {
  const row = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .get();
  return row?.value ?? null;
}

async function setConfigValue(key: string, value: string): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Cache an access URL (and the token that produced it) so syncs reuse it. */
export async function saveResolvedAccessUrl(
  accessUrl: string,
  sourceToken = "",
): Promise<void> {
  await setConfigValue(ACCESS_KEY, accessUrl);
  await setConfigValue(SOURCE_KEY, sourceToken);
}

/**
 * Resolve the SimpleFIN access URL from either an access URL or a setup token in
 * SIMPLEFIN_ACCESS_URL. A pasted access URL is authoritative and cached. A setup
 * token is claimed once and the resulting access URL is cached against that exact
 * token, so re-syncing reuses it (no repeat claim → no 403) while pasting a *new*
 * token triggers a fresh claim.
 */
export async function resolveAccessUrl(): Promise<string> {
  const raw = (process.env.SIMPLEFIN_ACCESS_URL ?? "").trim();

  // An access URL in the env wins and is cached.
  if (raw && isAccessUrl(raw)) {
    await setConfigValue(ACCESS_KEY, raw);
    await setConfigValue(SOURCE_KEY, "");
    return raw;
  }

  const cachedUrl = await getConfigValue(ACCESS_KEY);
  const cachedToken = await getConfigValue(SOURCE_KEY);

  // Same token we already claimed → reuse the cached access URL.
  if (raw && cachedUrl && cachedToken === raw) return cachedUrl;

  // No token provided but we have a cached URL → use it.
  if (!raw && cachedUrl) return cachedUrl;

  if (!raw) {
    throw new SyncError(
      "SIMPLEFIN_ACCESS_URL is not set. Paste your SimpleFIN setup token (or access URL) into .env.local.",
    );
  }

  // A new/unclaimed setup token → claim it once and cache it against the token.
  let accessUrl: string;
  try {
    accessUrl = await claimSetupToken(raw);
  } catch (e) {
    const why = e instanceof Error ? e.message : "Could not claim the setup token.";
    throw new SyncError(
      `${why} Get a fresh token at https://bridge.simplefin.org and paste it into SIMPLEFIN_ACCESS_URL, then sync again. (If you already have the access URL — https://user:pass@.../simplefin — paste that instead.)`,
    );
  }
  await setConfigValue(ACCESS_KEY, accessUrl);
  await setConfigValue(SOURCE_KEY, raw);
  return accessUrl;
}

/**
 * SimpleFIN caps history at ~90 days, so we always request a fixed window.
 * A constant (start-of-day) window also keeps provider-assigned IDs stable
 * between same-day syncs. Deeper history comes from the CSV importer.
 */
const SYNC_WINDOW_DAYS = 89;

export async function syncSimplefin(
  accessUrl?: string,
  opts: { deferCategorize?: boolean } = {},
): Promise<IngestSummary & { errors: string[]; autoCategorize: AutoResult | "deferred" }> {
  const url = accessUrl ?? (await resolveAccessUrl());

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startDate =
    Math.floor(startOfToday.getTime() / 1000) - SYNC_WINDOW_DAYS * 86400;

  const resp = await fetchSimplefin(url, { startDate, pending: true });
  const { accounts, errors } = simplefinToNormalized(resp);
  const summary = await ingestAccounts(accounts, "simplefin");
  // New rows land filed. Never throws: a categorisation failure is one log line, not a failed sync.
  // The web route defers it (after the response) so the Sync button never waits on a provider.
  return { ...summary, errors, autoCategorize: opts.deferCategorize ? "deferred" : await autoCategorize() };
}
