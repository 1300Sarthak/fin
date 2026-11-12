import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CONFIG_DEFAULTS, type ConfigKey } from "./config-constants";

/**
 * App-wide settings stored in the `app_config` key/value table.
 * Defaults & types live in `config-constants.ts` so scripts can import them too.
 */
export { CONFIG_DEFAULTS, type ConfigKey };

export async function getConfig(key: ConfigKey): Promise<string> {
  const row = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, key))
    .get();
  return row?.value ?? CONFIG_DEFAULTS[key];
}

export async function getConfigCents(key: ConfigKey): Promise<number | null> {
  const v = await getConfig(key);
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getAllConfig(): Promise<Record<ConfigKey, string>> {
  const rows = await db.select().from(appConfig);
  const map = { ...CONFIG_DEFAULTS } as Record<ConfigKey, string>;
  for (const r of rows) {
    if (r.key in map) map[r.key as ConfigKey] = r.value;
  }
  return map;
}

export async function setConfig(key: string, value: string): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Persistent "exclude the Cash account from net worth" preference. */
export async function getHideCash(): Promise<boolean> {
  return (await getConfig("hide_cash_from_net_worth")) === "1";
}

export async function setHideCash(hide: boolean): Promise<void> {
  await setConfig("hide_cash_from_net_worth", hide ? "1" : "0");
}

/** Persistent "hide $0-balance accounts from lists/dropdowns" preference. */
export async function getHideZeroAccounts(): Promise<boolean> {
  return (await getConfig("hide_zero_accounts")) === "1";
}

export async function setHideZeroAccounts(hide: boolean): Promise<void> {
  await setConfig("hide_zero_accounts", hide ? "1" : "0");
}

/** Ordered, persisted sidebar ids: section ids, or page ids from older saves. */
export async function getSidebarVisibleTabs(): Promise<string[]> {
  const value = await getConfig("sidebar_visible_tabs");
  const tabs = value.split(",").map((item) => item.trim()).filter((item) => item && item !== "next-6-months");
  // Migrate the retired destination once on read; new installs use the new defaults.
  const migrated = value.includes("next-6-months") ? [...new Set([...tabs, "planning", "taxes", "research"])] : tabs;
  // Lists saved before the assistant existed never offered it, so show it until
  // the user next saves their tabs. Read-only: this runs while pages prerender.
  return (await getConfig("sidebar_assistant_offered")) === "1" ? migrated : addAssistantTab(migrated);
}

/** Save the sidebar list; from then on the user's choice about the assistant stands. */
export async function setSidebarVisibleTabs(tabs: string[]): Promise<void> {
  await setConfig("sidebar_visible_tabs", tabs.join(","));
  await setConfig("sidebar_assistant_offered", "1");
}

/** Insert "assistant" right after "overview" (or first) unless already present. */
export function addAssistantTab(tabs: string[]): string[] {
  if (tabs.includes("assistant")) return tabs;
  const at = tabs.indexOf("overview") + 1;
  return [...tabs.slice(0, at), "assistant", ...tabs.slice(at)];
}
