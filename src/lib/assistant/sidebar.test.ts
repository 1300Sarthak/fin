import { describe, expect, test } from "bun:test";
import { db, schema } from "./test-db";
import { eq } from "drizzle-orm";

const { getSidebarVisibleTabs, setSidebarVisibleTabs, addAssistantTab } = await import("@/lib/config");
const PRODUCTION = "overview,accounts,cash,transactions,spending,earnings,investments,holdings,transfers,refunds,upcoming,recurring,reminders,goals,future-plan,next-6-months";

async function setRaw(key: string, value: string) {
  await db.insert(schema.appConfig).values({ key, value }).onConflictDoUpdate({ target: schema.appConfig.key, set: { value } });
}

describe("sidebar assistant tab", () => {
  test("a list saved before the assistant gains it once, after overview", async () => {
    await db.delete(schema.appConfig).where(eq(schema.appConfig.key, "sidebar_assistant_offered"));
    await setRaw("sidebar_visible_tabs", PRODUCTION);
    const tabs = await getSidebarVisibleTabs();
    expect(tabs.slice(0, 2)).toEqual(["overview", "assistant"]);
    expect(tabs).toContain("research");
  });

  test("reading never writes", async () => {
    expect((await db.select().from(schema.appConfig).where(eq(schema.appConfig.key, "sidebar_visible_tabs")).get())?.value).toBe(PRODUCTION);
  });

  test("hiding it afterwards is respected", async () => {
    await setSidebarVisibleTabs(["overview", "accounts"]);
    expect(await getSidebarVisibleTabs()).toEqual(["overview", "accounts"]);
  });

  test("addAssistantTab is idempotent", () => {
    expect(addAssistantTab(["overview", "assistant"])).toEqual(["overview", "assistant"]);
    expect(addAssistantTab(["accounts"])).toEqual(["assistant", "accounts"]);
  });
});
