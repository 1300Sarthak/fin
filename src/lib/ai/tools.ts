import "server-only";
import { and, desc, eq, gte, like, lte } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, recurringSeries, transactions } from "@/db/schema";
import { getNetWorthSummary } from "@/lib/networth";
import { getAccountsWithInstitution } from "@/lib/queries";
import {
  monthRange,
  getCashflow,
  getSpendingByAccount,
  getSpendingByCategory,
  getTopMerchants,
  getMonthlyTrend,
  getBudgetsWithActual,
} from "@/lib/spending";
import { formatDate, formatUSD } from "@/lib/format";
import { createCancellationReminder, getCancellationReminders } from "@/lib/cancellation-reminders";
import { getRefunds } from "@/lib/refunds";
import {
  isCashflowSummaryQuestion,
  isFinancialHealthQuestion,
  renderCashflowAnswer,
  renderFinancialHealthAnswer,
  requestedMonth,
  type CashflowSnapshot,
  type FinancialHealthSnapshot,
} from "./grounded-answer-core";
import type { ToolSpec } from "./types";

/**
 * Read-only tools the chat agent can call to ground its answers in real data.
 * Each maps to an existing query function; `runTool` formats cents → USD before
 * returning so the model never does cents arithmetic.
 */

const noArgs = { type: "object", additionalProperties: false, properties: {}, required: [] };
const monthArg = {
  type: "object",
  additionalProperties: false,
  properties: { month: { type: "string", description: "YYYY-MM; omit for the current month" } },
  required: [],
};

export const CHAT_TOOLS: ToolSpec[] = [
  {
    name: "get_financial_health",
    description: "A grounded financial-health snapshot: net worth, assets, debt, investment balances, and recent income, spending, and savings trend. Use for questions such as 'how am I doing financially?', especially when the user provides their age.",
    inputSchema: noArgs,
  },
  { name: "get_net_worth", description: "Total assets, liabilities, net worth, and day/week/month change.", inputSchema: noArgs },
  { name: "get_account_balances", description: "Per-account balances with institution and type.", inputSchema: noArgs },
  { name: "get_cashflow", description: "Income vs spending for a month.", inputSchema: monthArg },
  {
    name: "get_spending_by_category",
    description: "Spending grouped by category for a month, highest first, with % of total.",
    inputSchema: monthArg,
  },
  {
    name: "get_top_merchants",
    description: "Top merchants by spend for a month.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { month: { type: "string" }, limit: { type: "integer" } },
      required: [],
    },
  },
  {
    name: "get_monthly_trend",
    description: "Income and expense totals per month for the last N months (default 6).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { months: { type: "integer" } },
      required: [],
    },
  },
  {
    name: "get_budgets_status",
    description: "Each budget's limit, actual spend, and percent used for a month.",
    inputSchema: monthArg,
  },
  {
    name: "get_spending_by_card",
    description: "Spending grouped by payment account/card for a month, highest first. Includes net refunds and purchase count.",
    inputSchema: monthArg,
  },
  {
    name: "get_transactions",
    description: "Recent ledger transactions with date, merchant, amount, category, card/account, and flags. Use this when the user asks what a charge was, what they spent on, or transaction details.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        month: { type: "string", description: "YYYY-MM; omit for the current month" },
        merchant: { type: "string", description: "Optional merchant name to narrow results" },
        limit: { type: "integer", description: "1-20, default 12" },
      },
      required: [],
    },
  },
  {
    name: "get_refunds",
    description: "Confirmed refunds, including the refund date, amount, card/account, and the original purchase when linked.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", description: "1-20, default 12" } },
      required: [],
    },
  },
  {
    name: "get_recurring_subscriptions",
    description: "Detected recurring subscriptions and cancellation information: cadence, price, next expected date, status, cancel intent, cancellation URL, and note.",
    inputSchema: noArgs,
  },
  {
    name: "get_cancellation_reminders",
    description: "List the user's active cancellation reminders and their due dates.",
    inputSchema: noArgs,
  },
  {
    name: "create_cancellation_reminder",
    description: "Save a dated reminder to cancel one service or subscription. Call once per service only after the user provides a concrete date. dueDate must be YYYY-MM-DD.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Service or subscription to cancel, such as Google One" },
        dueDate: { type: "string", description: "Calendar date in YYYY-MM-DD" },
        note: { type: "string", description: "Optional short note from the user" },
      },
      required: ["name", "dueDate"],
    },
  },
];

type ToolInput = { month?: string; limit?: number; months?: number; name?: string; dueDate?: string; note?: string; merchant?: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function validMonth(value: unknown): string | undefined {
  return typeof value === "string" && MONTH.test(value) ? value : undefined;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export async function runTool(name: string, input: ToolInput = {}): Promise<string> {
  switch (name) {
    case "get_financial_health": {
      const [net, accountRows, trend] = await Promise.all([getNetWorthSummary(), getAccountsWithInstitution(), getMonthlyTrend(3)]);
      const investments = accountRows.filter((account) => account.isAsset && ["brokerage", "ira", "crypto"].includes(account.type)).reduce((total, account) => total + account.currentBalanceCents, 0);
      const debt = accountRows.filter((account) => !account.isAsset).reduce((total, account) => total + account.currentBalanceCents, 0);
      const activeMonths = trend.filter((month) => month.income > 0 || month.expense > 0);
      const totals = activeMonths.reduce((total, month) => ({ income: total.income + month.income, spending: total.spending + month.expense }), { income: 0, spending: 0 });
      const months = activeMonths.length;
      const averageIncome = months ? Math.round(totals.income / months) : 0;
      const averageSpending = months ? Math.round(totals.spending / months) : 0;
      const averageSaved = averageIncome - averageSpending;
      return JSON.stringify({
        netWorth: formatUSD(net.net), assets: formatUSD(net.assets), debt: formatUSD(debt), investments: formatUSD(investments), netWorthChangeThisMonth: formatUSD(net.deltaMonth),
        monthsOfCashflowData: months, averageMonthlyIncome: formatUSD(averageIncome), averageMonthlySpending: formatUSD(averageSpending), averageMonthlySaved: formatUSD(averageSaved),
        savingsRate: averageIncome > 0 ? `${Math.round((averageSaved / averageIncome) * 100)}%` : "not available (no income recorded)",
        recentMonths: trend.map((month) => ({ month: month.month, income: formatUSD(month.income), spending: formatUSD(month.expense), saved: formatUSD(month.income - month.expense) })),
        caveat: "This is a cash-flow and account-balance snapshot, not investment, tax, legal, or individualized financial advice.",
      });
    }
    case "get_net_worth": {
      const n = await getNetWorthSummary();
      return JSON.stringify({
        assets: formatUSD(n.assets),
        liabilities: formatUSD(n.liabilities),
        net: formatUSD(n.net),
        changeToday: formatUSD(n.deltaDay),
        changeWeek: formatUSD(n.deltaWeek),
        changeMonth: formatUSD(n.deltaMonth),
      });
    }
    case "get_account_balances": {
      const accts = await getAccountsWithInstitution();
      return JSON.stringify(
        accts.map((a) => ({
          name: a.name,
          type: a.type,
          institution: a.institution?.name ?? null,
          balance: formatUSD(a.currentBalanceCents),
          isAsset: a.isAsset,
        })),
      );
    }
    case "get_cashflow": {
      const r = monthRange(validMonth(input.month));
      const c = await getCashflow(r);
      return JSON.stringify({
        month: r.label,
        income: formatUSD(c.incomeCents),
        spending: formatUSD(c.spendingCents),
        net: formatUSD(c.net),
      });
    }
    case "get_spending_by_category": {
      const r = monthRange(validMonth(input.month));
      const rows = await getSpendingByCategory(r);
      return JSON.stringify({
        month: r.label,
        categories: rows.map((x) => ({
          category: x.name,
          spent: formatUSD(x.spentCents),
          pctOfSpending: Math.round(x.pct * 100),
          count: x.count,
        })),
      });
    }
    case "get_top_merchants": {
      const r = monthRange(validMonth(input.month));
      const rows = await getTopMerchants(r, boundedInt(input.limit, 8, 1, 20));
      return JSON.stringify({
        month: r.label,
        merchants: rows.map((x) => ({ merchant: x.merchant, spent: formatUSD(x.spentCents), count: x.count })),
      });
    }
    case "get_monthly_trend": {
      const rows = await getMonthlyTrend(boundedInt(input.months, 6, 1, 24));
      return JSON.stringify(
        rows.map((x) => ({ month: x.month, income: formatUSD(x.income), expense: formatUSD(x.expense) })),
      );
    }
    case "get_budgets_status": {
      const r = monthRange(validMonth(input.month));
      const rows = await getBudgetsWithActual(r);
      return JSON.stringify({
        month: r.label,
        budgets: rows.map((b) => ({
          category: b.name,
          limit: formatUSD(b.limitCents),
          spent: formatUSD(b.spentCents),
          pctUsed: Math.round(b.pct * 100),
        })),
      });
    }
    case "get_spending_by_card": {
      const r = monthRange(validMonth(input.month));
      const rows = await getSpendingByAccount(r);
      return JSON.stringify({
        month: r.label,
        cards: rows.map((x) => ({
          card: x.name,
          spent: formatUSD(x.spentCents),
          refunded: formatUSD(x.refundedCents),
          purchases: x.count,
        })),
      });
    }
    case "get_transactions": {
      const r = monthRange(validMonth(input.month));
      const merchant = typeof input.merchant === "string" ? input.merchant.trim().slice(0, 120) : "";
      const where = and(
        gte(transactions.postedAt, r.start),
        lte(transactions.postedAt, r.end),
        ...(merchant ? [like(transactions.payeeNormalized, `%${merchant.toLowerCase()}%`)] : []),
      );
      const rows = await db
        .select({
          postedAt: transactions.postedAt,
          amountCents: transactions.amountCents,
          merchant: transactions.merchantRaw,
          payee: transactions.payeeNormalized,
          category: categories.name,
          account: accounts.name,
          isRefund: transactions.isRefund,
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(where)
        .orderBy(desc(transactions.postedAt))
        .limit(boundedInt(input.limit, 12, 1, 20));
      return JSON.stringify({
        month: r.label,
        transactions: rows.map((x) => ({
          date: formatDate(x.postedAt),
          merchant: x.merchant || x.payee || "Unknown merchant",
          amount: formatUSD(x.amountCents),
          direction: x.amountCents < 0 ? "outflow" : "inflow",
          category: x.category ?? "Uncategorized",
          card: x.account,
          flags: [x.isRefund && "refund", x.isTransfer && "transfer", x.isExcluded && "excluded"].filter(Boolean),
        })),
      });
    }
    case "get_refunds": {
      const rows = (await getRefunds()).slice(0, boundedInt(input.limit, 12, 1, 20));
      return JSON.stringify(rows.map((r) => ({
        date: formatDate(r.postedAt),
        merchant: r.merchantRaw || r.payeeNormalized || "Unknown merchant",
        amount: formatUSD(r.amountCents),
        card: r.account?.name ?? "Unknown account",
        originalPurchase: r.refundsTransaction ? {
          date: formatDate(r.refundsTransaction.postedAt),
          merchant: r.refundsTransaction.merchantRaw || r.refundsTransaction.payeeNormalized || "Unknown merchant",
          amount: formatUSD(r.refundsTransaction.amountCents),
          card: r.refundsTransaction.account?.name ?? "Unknown account",
          category: r.refundsTransaction.category?.name ?? "Uncategorized",
        } : null,
      })));
    }
    case "get_recurring_subscriptions": {
      const rows = await db.select().from(recurringSeries).orderBy(desc(recurringSeries.expectedAmountCents));
      return JSON.stringify(rows.map((r) => ({
        name: r.payeeNormalized,
        cadence: r.cadence,
        expectedCharge: formatUSD(r.expectedAmountCents),
        lastCharge: formatUSD(r.lastAmountCents),
        nextExpected: r.nextExpectedAt ? formatDate(r.nextExpectedAt) : null,
        status: r.status,
        cancelIntent: r.cancelIntent,
        cancelUrl: r.cancelUrl,
        cancelNote: r.cancelNote,
      })));
    }
    case "get_cancellation_reminders": {
      const rows = await getCancellationReminders();
      return JSON.stringify(rows.map((r) => ({ id: r.id, name: r.name, dueDate: r.dueDate, note: r.note })));
    }
    case "create_cancellation_reminder": {
      if (!input.name || !input.dueDate) return JSON.stringify({ error: "name and dueDate are required" });
      try {
        const { reminder, created } = await createCancellationReminder({
          name: input.name,
          dueDate: input.dueDate,
          note: input.note,
        });
        return JSON.stringify({ ok: true, created, name: reminder.name, dueDate: reminder.dueDate });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : "Could not save reminder" });
      }
    }
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}

/**
 * Never give an LLM the last word on dashboard totals. These high-stakes
 * summary questions get a deterministic response assembled from the same
 * server calculations used by the pages, so it cannot turn a month's exact
 * spend into an approximate or a different month's value.
 */
export async function getGroundedFinanceAnswer(question: string): Promise<string | null> {
  if (isFinancialHealthQuestion(question)) {
    const snapshot = JSON.parse(await runTool("get_financial_health")) as FinancialHealthSnapshot;
    return renderFinancialHealthAnswer(snapshot);
  }
  if (isCashflowSummaryQuestion(question)) {
    const month = requestedMonth(question);
    const snapshot = JSON.parse(await runTool("get_cashflow", { month })) as CashflowSnapshot;
    return renderCashflowAnswer(snapshot);
  }
  return null;
}

/** Compact snapshot used when no tool-capable provider is available. */
export async function getSnapshot(): Promise<string> {
  const [health, net, cash, cats, cards, transactions, refunds, subscriptions, reminders] = await Promise.all([
    runTool("get_financial_health"),
    runTool("get_net_worth"),
    runTool("get_cashflow"),
    runTool("get_spending_by_category"),
    runTool("get_spending_by_card"),
    runTool("get_transactions", { limit: 12 }),
    runTool("get_refunds", { limit: 12 }),
    runTool("get_recurring_subscriptions"),
    runTool("get_cancellation_reminders"),
  ]);
  return [
    `financial_health=${health}`,
    `net_worth=${net}`,
    `cashflow=${cash}`,
    `spending_by_category=${cats}`,
    `spending_by_card=${cards}`,
    `recent_transactions=${transactions}`,
    `refunds=${refunds}`,
    `recurring_subscriptions=${subscriptions}`,
    `cancellation_reminders=${reminders}`,
  ].join("\n");
}
