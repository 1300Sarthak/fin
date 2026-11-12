import { drizzle } from "drizzle-orm/libsql";
import { createClient, type Client } from "@libsql/client";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:finance.db";

// Reuse a single libSQL client across Next.js dev HMR reloads.
const globalForDb = globalThis as unknown as { __financeDbClient?: Client; __financeDbPragmas?: Promise<void> };
const client = globalForDb.__financeDbClient ?? createClient({ url });
if (process.env.NODE_ENV !== "production") globalForDb.__financeDbClient = client;
// The sync worker writes for seconds at a time; WAL lets pages read meanwhile,
// and the timeout makes a write wait for the lock instead of failing at once.
if (url.startsWith("file:") && !globalForDb.__financeDbPragmas) {
  globalForDb.__financeDbPragmas = client.executeMultiple("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;").catch(() => {});
}

export const db = drizzle(client, { schema });
export { schema };
export type DB = typeof db;
