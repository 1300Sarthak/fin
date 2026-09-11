import { db } from "./index";
import { categories, goals, appConfig, categoryRules } from "./schema";
import { CONFIG_DEFAULTS } from "../lib/config-constants";
import { eq } from "drizzle-orm";

/**
 * Idempotent seed: category taxonomy, default config, and the snowball goals
 * (emergency fund -> max Roth IRA -> taxable investing).
 * Safe to run repeatedly — it only inserts when a table is empty / key missing.
 */

type SeedCat = {
  name: string;
  kind: "income" | "expense" | "transfer" | "investment";
  icon?: string;
  children?: { name: string; icon?: string }[];
};

const TAXONOMY: SeedCat[] = [
  {
    name: "Income",
    kind: "income",
    icon: "banknote",
    children: [
      { name: "Paycheck", icon: "wallet" },
      { name: "Interest", icon: "percent" },
      { name: "Refunds", icon: "rotate-ccw" },
      { name: "Other Income", icon: "circle-plus" },
    ],
  },
  {
    name: "Housing",
    kind: "expense",
    icon: "home",
    children: [
      { name: "Rent / Mortgage", icon: "key" },
      { name: "Home Utilities", icon: "plug" },
    ],
  },
  { name: "Groceries", kind: "expense", icon: "shopping-cart" },
  {
    name: "Food & Dining",
    kind: "expense",
    icon: "utensils",
    children: [
      { name: "Restaurants", icon: "utensils" },
      { name: "Coffee Shops", icon: "coffee" },
      { name: "Fast Food", icon: "sandwich" },
    ],
  },
  {
    name: "Transportation",
    kind: "expense",
    icon: "car",
    children: [
      { name: "Gas", icon: "fuel" },
      { name: "Rideshare", icon: "car-taxi-front" },
      { name: "Public Transit", icon: "train-front" },
      { name: "Parking", icon: "square-parking" },
    ],
  },
  {
    name: "Shopping",
    kind: "expense",
    icon: "shopping-bag",
    children: [
      { name: "Clothing", icon: "shirt" },
      { name: "Electronics", icon: "laptop" },
      { name: "General Merchandise", icon: "package" },
    ],
  },
  {
    name: "Subscriptions",
    kind: "expense",
    icon: "repeat",
    children: [
      { name: "Streaming", icon: "tv" },
      { name: "Software", icon: "app-window" },
      { name: "Memberships", icon: "badge-check" },
    ],
  },
  {
    name: "Bills & Utilities",
    kind: "expense",
    icon: "receipt",
    children: [
      { name: "Phone", icon: "smartphone" },
      { name: "Internet", icon: "wifi" },
      { name: "Electric & Gas", icon: "zap" },
    ],
  },
  {
    name: "Health & Fitness",
    kind: "expense",
    icon: "heart-pulse",
    children: [
      { name: "Pharmacy", icon: "pill" },
      { name: "Gym", icon: "dumbbell" },
      { name: "Medical", icon: "stethoscope" },
    ],
  },
  { name: "Entertainment", kind: "expense", icon: "clapperboard" },
  { name: "Travel", kind: "expense", icon: "plane" },
  { name: "Education", kind: "expense", icon: "graduation-cap" },
  { name: "Personal Care", kind: "expense", icon: "sparkles" },
  { name: "Gifts & Donations", kind: "expense", icon: "gift" },
  { name: "Fees & Charges", kind: "expense", icon: "circle-dollar-sign" },
  { name: "Taxes", kind: "expense", icon: "landmark" },
  { name: "Other", kind: "expense", icon: "circle-help" },
  {
    name: "Transfers",
    kind: "transfer",
    icon: "arrow-left-right",
    children: [
      { name: "Credit Card Payment", icon: "credit-card" },
      { name: "Account Transfer", icon: "arrow-left-right" },
    ],
  },
  {
    name: "Investments",
    kind: "investment",
    icon: "trending-up",
    children: [
      { name: "Brokerage", icon: "line-chart" },
      { name: "Retirement", icon: "piggy-bank" },
      { name: "Crypto", icon: "bitcoin" },
    ],
  },
];

async function seedCategories() {
  const existing = await db.$count(categories);
  if (existing > 0) {
    console.log(`• categories: already seeded (${existing})`);
    return;
  }
  let sort = 0;
  for (const top of TAXONOMY) {
    const [parent] = await db
      .insert(categories)
      .values({
        name: top.name,
        kind: top.kind,
        icon: top.icon,
        isSystem: true,
        sortOrder: sort++,
      })
      .returning();
    for (const child of top.children ?? []) {
      await db.insert(categories).values({
        name: child.name,
        parentId: parent.id,
        kind: top.kind,
        icon: child.icon,
        isSystem: true,
        sortOrder: sort++,
      });
    }
  }
  console.log(`✓ categories seeded (${await db.$count(categories)})`);
}

async function seedGoals() {
  const existing = await db.$count(goals);
  if (existing > 0) {
    console.log(`• goals: already seeded (${existing})`);
    return;
  }
  await db.insert(goals).values([
    {
      name: "Emergency Fund",
      type: "emergency_fund",
      targetCents: 500000, // $5,000 in HYSA
      priority: 0,
    },
    {
      name: "Max Roth IRA",
      type: "retirement",
      targetCents: 750000, // $7,500 (2026 limit)
      annualCapCents: 750000,
      priority: 1,
    },
    {
      name: "Invest (Stocks & Crypto)",
      type: "taxable_invest",
      targetCents: 0, // open-ended overflow bucket
      priority: 2,
    },
  ]);
  console.log("✓ goals seeded (emergency fund -> Roth -> taxable)");
}

async function seedConfig() {
  const rows = Object.entries(CONFIG_DEFAULTS)
    .filter(([, v]) => v !== "")
    .map(([key, value]) => ({ key, value }));
  await db.insert(appConfig).values(rows).onConflictDoNothing();
  console.log(`✓ config defaults ensured (${rows.length})`);
}

// Deterministic merchant rules: matched (substring, lowercased) before any AI
// call, so common merchants categorize instantly and for free.
const RULES: { pattern: string; category: string }[] = [
  // Income / transfers
  { pattern: "payroll", category: "Paycheck" },
  { pattern: "paycheck", category: "Paycheck" },
  { pattern: "direct deposit", category: "Paycheck" },
  { pattern: "salary", category: "Paycheck" },
  { pattern: "interest", category: "Interest" },
  { pattern: "payment thank you", category: "Credit Card Payment" },
  { pattern: "credit card payment", category: "Credit Card Payment" },
  { pattern: "autopay", category: "Credit Card Payment" },
  { pattern: "online transfer", category: "Account Transfer" },
  { pattern: "transfer to", category: "Account Transfer" },
  { pattern: "transfer from", category: "Account Transfer" },
  // Groceries
  { pattern: "grocery", category: "Groceries" },
  { pattern: "supermarket", category: "Groceries" },
  { pattern: "whole foods", category: "Groceries" },
  { pattern: "trader joe", category: "Groceries" },
  { pattern: "safeway", category: "Groceries" },
  { pattern: "kroger", category: "Groceries" },
  { pattern: "aldi", category: "Groceries" },
  { pattern: "costco", category: "Groceries" },
  // Coffee / dining
  { pattern: "starbucks", category: "Coffee Shops" },
  { pattern: "coffee", category: "Coffee Shops" },
  { pattern: "dunkin", category: "Coffee Shops" },
  { pattern: "mcdonald", category: "Fast Food" },
  { pattern: "chipotle", category: "Fast Food" },
  { pattern: "taco bell", category: "Fast Food" },
  { pattern: "burger", category: "Fast Food" },
  { pattern: "doordash", category: "Restaurants" },
  { pattern: "uber eats", category: "Restaurants" },
  { pattern: "grubhub", category: "Restaurants" },
  { pattern: "restaurant", category: "Restaurants" },
  { pattern: "fishin", category: "Restaurants" }, // demo: "John's Fishin Shack"
  // Transport
  { pattern: "uber", category: "Rideshare" },
  { pattern: "lyft", category: "Rideshare" },
  { pattern: "shell", category: "Gas" },
  { pattern: "chevron", category: "Gas" },
  { pattern: "exxon", category: "Gas" },
  { pattern: "gas station", category: "Gas" },
  // Subscriptions / bills
  { pattern: "netflix", category: "Streaming" },
  { pattern: "spotify", category: "Streaming" },
  { pattern: "hulu", category: "Streaming" },
  { pattern: "disney", category: "Streaming" },
  { pattern: "at&t", category: "Phone" },
  { pattern: "verizon", category: "Phone" },
  { pattern: "t-mobile", category: "Phone" },
  { pattern: "comcast", category: "Internet" },
  { pattern: "xfinity", category: "Internet" },
  // Shopping
  { pattern: "amazon", category: "General Merchandise" },
  { pattern: "walmart", category: "General Merchandise" },
  { pattern: "target", category: "General Merchandise" },
  // Health
  { pattern: "cvs", category: "Pharmacy" },
  { pattern: "walgreens", category: "Pharmacy" },
  { pattern: "gym", category: "Gym" },
  { pattern: "fitness", category: "Gym" },
  // Fees
  { pattern: "fee", category: "Fees & Charges" },
  { pattern: "service charge", category: "Fees & Charges" },
];

async function seedRules() {
  const existing = await db.$count(categoryRules);
  if (existing > 0) {
    console.log(`• rules: already seeded (${existing})`);
    return;
  }
  let n = 0;
  for (const r of RULES) {
    const cat = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.name, r.category))
      .get();
    if (!cat) continue;
    await db.insert(categoryRules).values({
      pattern: r.pattern,
      categoryId: cat.id,
      createdBy: "system",
      priority: 50,
    });
    n++;
  }
  console.log(`✓ rules seeded (${n})`);
}

await seedCategories();
await seedGoals();
await seedConfig();
await seedRules();
console.log("seed complete");
