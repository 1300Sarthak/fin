import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { setConfig } from "@/lib/config";

/**
 * Session generation in app_config. Every session cookie records the generation
 * it was issued under; bumping it ("sign out everywhere") invalidates them all.
 *
 * The proxy reads this on every gated request, so it is cached briefly. The
 * process that bumps it updates the cache at once; any other process sees the
 * new value within CACHE_MS.
 */
export const GENERATION_KEY = "auth_session_generation";
const CACHE_MS = 2_000;
const cache = globalThis as unknown as { __finSessionGen?: { value: number; at: number } };

export const parseGeneration = (raw: string | undefined | null) => {
  const n = Number(raw);
  return raw && Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

export async function getSessionGeneration(now = Date.now()): Promise<number> {
  const hit = cache.__finSessionGen;
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const row = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, GENERATION_KEY)).get();
  const value = parseGeneration(row?.value);
  cache.__finSessionGen = { value, at: now };
  return value;
}

export async function bumpSessionGeneration(): Promise<number> {
  cache.__finSessionGen = undefined;
  const next = (await getSessionGeneration()) + 1;
  await setConfig(GENERATION_KEY, String(next));
  cache.__finSessionGen = { value: next, at: Date.now() };
  return next;
}
