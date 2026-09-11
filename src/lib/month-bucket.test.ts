/**
 * Guards the two SQLite footguns that silently zeroed the Earnings page.
 *
 * `postedAt` is stored as unix seconds. Both bugs came from forgetting that
 * inside a raw `sql` template, where Drizzle's column mappers do not apply.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { and, gte, lte, sql } from "drizzle-orm";

const rows = sqliteTable("rows", {
  id: integer().primaryKey({ autoIncrement: true }),
  postedAt: integer({ mode: "timestamp" }).notNull(),
  amountCents: integer().notNull(),
});

const db = drizzle(createClient({ url: ":memory:" }), { schema: { rows } });
const JUNE = new Date("2026-06-01T00:00:00Z");
const JUNE_END = new Date("2026-06-30T23:59:59Z");

beforeAll(async () => {
  await db.run(sql`CREATE TABLE rows (id integer primary key autoincrement, postedAt integer not null, amountCents integer not null)`);
  await db.insert(rows).values([
    { postedAt: new Date("2026-06-15T12:00:00Z"), amountCents: 100 },
    { postedAt: new Date("2026-08-15T12:00:00Z"), amountCents: 900 },
  ]);
});

describe("month bucketing on an integer timestamp column", () => {
  test("a Date interpolated into raw SQL never matches, so bounds must use the typed operators", async () => {
    // SQLite orders INTEGER before TEXT, so a Date bound as text makes
    // `int >= text` always false and `int <= text` always true. That is why the
    // month total read $0 while the month's upper bound went missing entirely.
    const broken = await db
      .select({ v: sql<number>`COALESCE(SUM(CASE WHEN ${rows.postedAt} >= ${JUNE} THEN ${rows.amountCents} ELSE 0 END), 0)` })
      .from(rows)
      .get();
    expect(broken?.v).toBe(0);

    const upperBoundIgnored = await db
      .select({ v: sql<number>`COALESCE(SUM(${rows.amountCents}), 0)` })
      .from(rows)
      .where(sql`${rows.postedAt} <= ${JUNE_END}`)
      .get();
    expect(upperBoundIgnored?.v).toBe(1000); // August leaked in

    const fixed = await db
      .select({ v: sql<number>`COALESCE(SUM(CASE WHEN ${gte(rows.postedAt, JUNE)} AND ${lte(rows.postedAt, JUNE_END)} THEN ${rows.amountCents} ELSE 0 END), 0)` })
      .from(rows)
      .get();
    expect(fixed?.v).toBe(100);

    const bounded = await db
      .select({ v: sql<number>`COALESCE(SUM(${rows.amountCents}), 0)` })
      .from(rows)
      .where(and(gte(rows.postedAt, JUNE), lte(rows.postedAt, JUNE_END)))
      .get();
    expect(bounded?.v).toBe(100);
  });

  test("strftime needs the unixepoch modifier or every bucket key is null", async () => {
    const broken = await db.select({ m: sql<string>`strftime('%Y-%m', ${rows.postedAt})` }).from(rows).all();
    expect(broken.every((r) => !r.m)).toBe(true);

    const fixed = await db.select({ m: sql<string>`strftime('%Y-%m', ${rows.postedAt}, 'unixepoch')` }).from(rows).all();
    expect(fixed.map((r) => r.m)).toEqual(["2026-06", "2026-08"]);
  });
});
