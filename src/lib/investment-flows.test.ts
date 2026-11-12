import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { format } from "date-fns";
import { db } from "@/db";
import { accounts, transactions } from "@/db/schema";
import { presetRange } from "@/components/kit/range";
import { investments } from "../../cli/commands/money";
import { parse } from "../../cli/args";
import { getInvestmentHistory, investmentFlows } from "./investment-history";

// `fin investments --json` must print the figures /investments shows: the page
// sums getInvestmentHistory({ from, to, includeInternal: true }) per account.
const made = { txns: [] as number[], accounts: [] as number[] };
const today = format(new Date(), "yyyy-MM-dd");
const at = (iso: string) => new Date(`${iso}T12:00:00`);

beforeAll(async () => {
  const [broker] = await db.insert(accounts).values({ name: "Flows Brokerage", type: "brokerage", source: "manual", currentBalanceCents: 500_000 }).returning();
  made.accounts.push(broker.id);
  const row = (iso: string, amountCents: number, merchantRaw: string) => ({ accountId: broker.id, postedAt: at(iso), amountCents, merchantRaw, source: "manual" as const });
  const rows = await db.insert(transactions).values([
    row("2031-03-02", 1_250, "Dividend Received"),
    row("2031-03-31", 99, "Interest Income"),
    row("2031-04-10", -20, "Foreign Tax Paid"),
    row("2031-05-01", -292_203, "Withdrawal to bank"),
    row("2031-06-01", 100_000, "Deposit from checking"),
    // Outside the custom range: a figure that ignores the range would count these.
    row("2030-12-30", 5_000, "Dividend Received"),
    row("2031-08-01", -32, "Account Fee"),
    // Today, so year to date is not empty.
    row(today, 777, "Dividend Received"),
  ]).returning({ id: transactions.id });
  made.txns.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  await db.delete(transactions).where(inArray(transactions.id, made.txns));
  await db.delete(accounts).where(inArray(accounts.id, made.accounts));
});

async function cliJson(argv: string[]) {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await investments(parse(argv), true);
    return JSON.parse(String(log.mock.calls[0][0]));
  } finally {
    log.mockRestore();
  }
}

const pageFlows = async (from: string | null, to: string | null) =>
  investmentFlows(await getInvestmentHistory({ from: from ?? undefined, to: to ?? undefined, includeInternal: true }));

describe("fin investments matches /investments", () => {
  test("default is year to date, like the page", async () => {
    const ytd = presetRange("ytd");
    const out = await cliJson([]);
    expect(out.range).toEqual({ from: ytd.from, to: ytd.to, label: ytd.label });
    expect(out.flows).toEqual(await pageFlows(ytd.from, ytd.to));
    expect(out.flows.dividendCents).toBeGreaterThanOrEqual(777);
  });

  test("a custom range counts only that range", async () => {
    const out = await cliJson(["--from", "2031-01-01", "--to", "2031-06-30"]);
    expect(out.flows).toEqual(await pageFlows("2031-01-01", "2031-06-30"));
    expect(out.flows).toMatchObject({ dividendCents: 1_250, interestCents: 99, feeCents: 20, transferOutCents: 292_203, transferInCents: 100_000 });
  });

  test("--period all and bad input", async () => {
    expect((await cliJson(["--period", "all"])).flows).toEqual(await pageFlows(null, null));
    await expect(cliJson(["--from", "2031-01-01"])).rejects.toThrow("--from and --to go together");
    await expect(cliJson(["--period", "ytd", "--from", "2031-01-01", "--to", "2031-02-01"])).rejects.toThrow("one of");
    await expect(cliJson(["--period", "forever"])).rejects.toThrow();
  });
});
