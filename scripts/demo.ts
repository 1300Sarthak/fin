/** A reproducible fictional household. Never reads or overwrites the owner's database. */
import { mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const target = resolve(".data/demo.db");
await mkdir(".data", { recursive: true });
try { await access(target); console.error("Demo database already exists. Use bun run demo to open it."); process.exit(1); } catch {}
process.env.DATABASE_URL = `file:${target}`;
for (const file of ["src/db/migrate.ts", "src/db/seed.ts"]) {
  const result = spawnSync("bun", ["--conditions", "react-server", file], { env: process.env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const { db } = await import("../src/db");
const s = await import("../src/db/schema");
const [institution] = await db.insert(s.institutions).values({ name: "Demo Community Bank", kind: "bank" }).returning();
const accounts = await db.insert(s.accounts).values([
  { name: "Everyday checking", type: "checking", currentBalanceCents: 425000, institutionId: institution.id, source: "demo" },
  { name: "Emergency savings", type: "hysa", currentBalanceCents: 1800000, institutionId: institution.id, source: "demo" },
  { name: "Long-term investments", type: "brokerage", currentBalanceCents: 3275000, institutionId: institution.id, source: "demo" },
  { name: "Everyday card", type: "credit", currentBalanceCents: 62500, isAsset: false, institutionId: institution.id, source: "demo" },
]).returning();
const cats = await db.select().from(s.categories);
const category = (name: string) => cats.find(c => c.name === name)!.id;
const today = new Date();
for (let month = 0; month < 6; month++) {
  const date = (day: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - month, Math.min(day, month === 0 ? today.getUTCDate() : 28), 12));
  const rows = [
    ["Example payroll", 520000, "Paycheck"], ["Maple apartments", -165000, "Rent / Mortgage"],
    ["Neighborhood market", -42500, "Groceries"], ["City transit", -9500, "Public Transit"],
    ["Corner cafe", -6400, "Coffee Shops"], ["Home internet", -6500, "Internet"],
    ["Cinema subscription", -1800, "Streaming"], ["Weekend dining", -21000, "Restaurants"],
    ["Learning library", -4500, "Education"], ["General store", -14200, "General Merchandise"],
  ] as const;
  await db.insert(s.transactions).values(rows.map(([merchant, amount, cat], i) => ({ accountId: accounts[0].id, postedAt: date(i + 1), amountCents: amount, merchantRaw: merchant, payeeNormalized: merchant.toLowerCase(), categoryId: category(cat), categorySource: "manual", source: "demo" })));
}
for (let days = 90; days >= 0; days--) {
  const d = new Date(today); d.setUTCDate(d.getUTCDate() - days);
  await db.insert(s.balanceSnapshots).values(accounts.map(a => ({ accountId: a.id, date: d.toISOString().slice(0,10), balanceCents: Math.round(a.currentBalanceCents * (a.isAsset ? 1 - days * .001 : 1)), isAsset: a.isAsset })));
}
await db.insert(s.holdings).values([
  { accountId: accounts[2].id, externalId: "demo-vti", symbol: "VTI", description: "Illustrative broad-market ETF position", shares: 100, marketValueCents: 2750000, costPerShareCents: 22000 },
  { accountId: accounts[2].id, externalId: "demo-bnd", symbol: "BND", description: "Illustrative bond ETF position", shares: 70, marketValueCents: 525000, costPerShareCents: 7300 },
]);
await db.insert(s.budgets).values([{ categoryId: category("Groceries"), limitCents: 50000 }, { categoryId: category("Restaurants"), limitCents: 25000 }]);
await db.insert(s.recurringSeries).values({ payeeNormalized: "cinema subscription", accountId: accounts[0].id, categoryId: category("Streaming"), expectedAmountCents: 1800, lastAmountCents: 1800, occurrences: 6, cadence: "monthly", nextExpectedAt: new Date(Date.now() + 7 * 86400000) });
const { savePlanningProfile } = await import("../src/lib/financial-planning");
await savePlanningProfile({ monthlyTakeHome: 5200, monthlyEssentials: 2200, monthlyFlexible: 550, monthlyDebtPayments: 100, monthlyInvesting: 900, emergencyMonths: 6, goalName: "A place of our own", goalTarget: 25000, goalSaved: 8000, goalMonths: 24, notes: "Fictional demo household. All figures are synthetic.", tax: { wagesBox1: 82000, withholdingBox2: 10000, retirementContributions: 6000 } });
// A monthly budget, so `fin allowance` and the budget cards have something to
// work against out of the box rather than telling a first-time reader to go
// set one before the command does anything.
await db.insert(s.appConfig).values([
  { key: "demo_mode", value: "1" },
  { key: "monthly_budget_cents", value: "300000" },
]);
console.log("Synthetic demo ready: .data/demo.db. Run bun run demo.");
process.exit(0);
