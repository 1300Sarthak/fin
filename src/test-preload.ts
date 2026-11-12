/**
 * Runs before every test file (see bunfig.toml). Every file in a `bun test` run
 * shares one module cache, so whichever test first imports `@/db` fixes the
 * connection for the whole run. Pointing DATABASE_URL at a migrated throwaway
 * file here means no test can ever open the real ledger, and `server-only` is
 * stubbed because tests run without the react-server condition.
 */
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

mock.module("server-only", () => ({}));
const url = `file:${join(mkdtempSync(join(tmpdir(), "finance-test-")), "test.db")}`;
process.env.DATABASE_URL = url;
const client = createClient({ url });
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
client.close();
