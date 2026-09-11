import { drizzle } from "drizzle-orm/libsql";
import { createClient, type Client } from "@libsql/client";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:finance.db";

// Reuse a single libSQL client across Next.js dev HMR reloads.
const globalForDb = globalThis as unknown as { __financeDbClient?: Client };
const client = globalForDb.__financeDbClient ?? createClient({ url });
if (process.env.NODE_ENV !== "production") globalForDb.__financeDbClient = client;

export const db = drizzle(client, { schema });
export { schema };
export type DB = typeof db;
