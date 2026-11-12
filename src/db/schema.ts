import { sql, relations } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * Conventions
 * - All money is stored as INTEGER cents (avoids float drift). `amountCents`
 *   on transactions is SIGNED: negative = money out (spending), positive = money in.
 * - Account balances are stored normalized in `currentBalanceCents`: a positive
 *   number for assets, and for liabilities (credit cards) the amount OWED as a
 *   positive number. `isAsset` distinguishes the two for net-worth math.
 * - Timestamps use unix-epoch seconds (mode: "timestamp"). Calendar-only values
 *   (balance snapshots) use a "YYYY-MM-DD" text date for easy grouping.
 */

const now = sql`(unixepoch())`;

export const accountType = [
  "checking",
  "savings",
  "hysa",
  "hsa",
  "credit",
  "brokerage",
  "ira",
  "crypto",
  "cash",
  "loan",
  "other",
] as const;
export type AccountType = (typeof accountType)[number];

export const institutions = sqliteTable("institutions", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  simplefinOrgId: text().unique(),
  domain: text(),
  kind: text(), // bank | brokerage | card | crypto
  createdAt: integer({ mode: "timestamp" }).notNull().default(now),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    institutionId: integer().references(() => institutions.id),
    externalId: text(), // SimpleFIN account id (for idempotent upsert)
    name: text().notNull(),
    type: text({ enum: accountType }).notNull().default("other"),
    currency: text().notNull().default("USD"),
    currentBalanceCents: integer().notNull().default(0),
    availableBalanceCents: integer(),
    isAsset: integer({ mode: "boolean" }).notNull().default(true),
    isActive: integer({ mode: "boolean" }).notNull().default(true),
    source: text().notNull().default("manual"), // simplefin | csv | manual
    sortOrder: integer().notNull().default(0), // manual display order
    // When the *provider* last observed this balance, as opposed to when we
    // last talked to the provider (`lastSyncedAt`). A stalled connection still
    // answers every sync, handing back a figure that stopped moving weeks ago,
    // so these two diverge and only this one says whether the number is current.
    balanceDate: integer({ mode: "timestamp" }),
    lastSyncedAt: integer({ mode: "timestamp" }),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [unique("accounts_external_uq").on(t.externalId)],
);

export const categories = sqliteTable("categories", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  parentId: integer(),
  kind: text().notNull().default("expense"), // income | expense | transfer | investment
  icon: text(),
  color: text(),
  isSystem: integer({ mode: "boolean" }).notNull().default(true),
  sortOrder: integer().notNull().default(0),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer()
      .notNull()
      .references(() => accounts.id),
    externalId: text(), // SimpleFIN txn id (unique per account)
    postedAt: integer({ mode: "timestamp" }).notNull(),
    amountCents: integer().notNull(), // signed: negative = outflow
    merchantRaw: text().notNull().default(""),
    payeeNormalized: text().notNull().default(""),
    memo: text(),
    note: text(), // user "what was this?" hint -> feeds re-categorization
    categoryId: integer().references(() => categories.id),
    categorySource: text().notNull().default("uncategorized"), // rule|cache|ai|manual|uncategorized
    categoryConfidence: real(),
    isPending: integer({ mode: "boolean" }).notNull().default(false),
    isRecurring: integer({ mode: "boolean" }).notNull().default(false),
    isTransfer: integer({ mode: "boolean" }).notNull().default(false),
    // The other side of a transfer paired by the user.  This is deliberately
    // stored in both directions, so undoing the decision can safely restore
    // both ledger rows without guessing at another equal-dollar transaction.
    transferPairTxnId: integer(),
    // A user override for activity that should remain visible in the ledger but
    // never affect income, spending, cash flow, budgets, or insights.
    isExcluded: integer({ mode: "boolean" }).notNull().default(false),
    // A money-in transaction that gives back an earlier purchase (return,
    // price adjustment, reimbursement). Refunds stay visible in the ledger but
    // are netted OUT of spending totals instead of counted as income, so the
    // pie chart shows what was actually spent. See lib/refunds.ts.
    isRefund: integer({ mode: "boolean" }).notNull().default(false),
    // The purchase this refund reverses. A linked refund is attributed back to
    // that purchase's month and category, so a July charge refunded in August
    // stops counting as July spending instead of leaving a phantom in the pie.
    refundsTxnId: integer(),
    recurringSeriesId: integer(),
    source: text().notNull().default("manual"),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [
    unique("tx_account_external_uq").on(t.accountId, t.externalId),
    index("tx_posted_idx").on(t.postedAt),
    index("tx_account_idx").on(t.accountId),
    index("tx_category_idx").on(t.categoryId),
    index("tx_payee_idx").on(t.payeeNormalized),
  ],
);

export const categoryRules = sqliteTable("category_rules", {
  id: integer().primaryKey({ autoIncrement: true }),
  pattern: text().notNull(), // substring (lowercased) or regex source
  isRegex: integer({ mode: "boolean" }).notNull().default(false),
  categoryId: integer()
    .notNull()
    .references(() => categories.id),
  priority: integer().notNull().default(100),
  createdBy: text().notNull().default("user"), // system | user
  createdAt: integer({ mode: "timestamp" }).notNull().default(now),
});

export const merchantCache = sqliteTable("merchant_cache", {
  id: integer().primaryKey({ autoIncrement: true }),
  normalizedMerchant: text().notNull().unique(),
  categoryId: integer()
    .notNull()
    .references(() => categories.id),
  confidence: real(),
  updatedAt: integer({ mode: "timestamp" }).notNull().default(now),
});

export const changeKind = ["recategorize", "split", "reimbursement", "exclude", "include", "cli"] as const;
export type ChangeKind = (typeof changeKind)[number];
export const changeStatus = ["proposed", "applied", "discarded", "undone"] as const;
export type ChangeStatus = (typeof changeStatus)[number];

/**
 * Audit log for ledger edits made through the money assistant (or its CLI
 * twin). A row is first a PROPOSAL: nothing in `transactions` changes until
 * `applyChange` runs. `beforeJson` is the exact state the edit replaces, so it
 * can be refused as stale and restored byte for byte; `afterJson` records what
 * was written, including any rule or cache entry created along the way.
 */
export const ledgerChanges = sqliteTable(
  "ledger_changes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
    status: text({ enum: changeStatus }).notNull().default("proposed"),
    kind: text({ enum: changeKind }).notNull(),
    txnId: integer().notNull(),
    summary: text().notNull(),
    beforeJson: text().notNull(),
    afterJson: text().notNull(),
    appliedAt: integer({ mode: "timestamp" }),
    undoneAt: integer({ mode: "timestamp" }),
    origin: text({ enum: ["assistant", "cli"] }).notNull().default("assistant"),
  },
  (t) => [index("ledger_changes_txn_idx").on(t.txnId), index("ledger_changes_status_idx").on(t.status)],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer()
      .notNull()
      .references(() => accounts.id),
    date: text().notNull(), // YYYY-MM-DD
    balanceCents: integer().notNull(),
    isAsset: integer({ mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    unique("snapshot_account_date_uq").on(t.accountId, t.date),
    index("snapshot_date_idx").on(t.date),
  ],
);

/**
 * Hand-recorded net worth checkpoints (the "Current Value" ledger). Each
 * milestone has a recorded total plus the per-account lines behind it; lines
 * marked `isExcluded` are tracked alongside but deliberately left out of the
 * total (e.g. "money I get owed"), matching how the numbers were kept by hand.
 */
export const netWorthMilestones = sqliteTable(
  "net_worth_milestones",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    date: text().notNull(), // YYYY-MM-DD
    label: text().notNull(),
    totalCents: integer().notNull().default(0),
    goal: text(),
    note: text(),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [
    unique("milestone_date_uq").on(t.date),
    index("milestone_date_idx").on(t.date),
  ],
);

export const netWorthMilestoneLines = sqliteTable(
  "net_worth_milestone_lines",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    milestoneId: integer()
      .notNull()
      .references(() => netWorthMilestones.id, { onDelete: "cascade" }),
    label: text().notNull(),
    cents: integer().notNull().default(0), // signed: negative = debt
    note: text(),
    isExcluded: integer({ mode: "boolean" }).notNull().default(false),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [index("milestone_line_idx").on(t.milestoneId)],
);

/**
 * Security positions inside an investment account, as the provider last
 * reported them. Replaced wholesale on every sync rather than appended: this is
 * a snapshot of what is held right now, not a history of trades — the trades
 * are already in `transactions`.
 *
 * Prices lag one trading day (verified against a provider statement: share
 * counts and cost bases matched exactly, market values differed by precisely
 * that day's move), so `asOf` is stored and must be shown wherever a value is.
 */
export const holdings = sqliteTable(
  "holdings",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    symbol: text(),
    description: text(),
    /** Fractional shares are normal here, so this stays a float, not cents. */
    shares: real().notNull().default(0),
    marketValueCents: integer().notNull().default(0),
    /** Per-share average cost. Null when the provider omits it (e.g. crypto). */
    costPerShareCents: integer(),
    currency: text().notNull().default("USD"),
    asOf: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [
    unique("holding_account_external_uq").on(t.accountId, t.externalId),
    index("holding_account_idx").on(t.accountId),
  ],
);

export const budgets = sqliteTable(
  "budgets",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    categoryId: integer()
      .notNull()
      .references(() => categories.id),
    period: text().notNull().default("monthly"),
    limitCents: integer().notNull(),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [unique("budget_category_period_uq").on(t.categoryId, t.period)],
);

export const goalType = [
  "emergency_fund",
  "retirement",
  "taxable_invest",
  "debt_payoff",
  "custom",
] as const;
export type GoalType = (typeof goalType)[number];

export const goals = sqliteTable("goals", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  type: text({ enum: goalType }).notNull().default("custom"),
  targetCents: integer().notNull().default(0), // 0 = open-ended "overflow" bucket
  annualCapCents: integer(), // e.g. Roth IRA yearly max
  linkedAccountId: integer().references(() => accounts.id),
  parentGoalId: integer(), // self-ref for sub-goals (relation-only, like categories.parentId)
  priority: integer().notNull().default(0), // lower = funded first (snowball order)
  monthlyContributionCents: integer(), // optional per-month cap
  targetDate: text(), // YYYY-MM-DD, optional
  isActive: integer({ mode: "boolean" }).notNull().default(true),
  createdAt: integer({ mode: "timestamp" }).notNull().default(now),
});

// Many-to-many: a goal can track several accounts (sum of their balances).
export const goalAccounts = sqliteTable(
  "goal_accounts",
  {
    goalId: integer()
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    accountId: integer()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.goalId, t.accountId] }),
    index("goal_accounts_goal_idx").on(t.goalId),
  ],
);

export const recurringSeries = sqliteTable(
  "recurring_series",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    payeeNormalized: text().notNull(),
    accountId: integer().references(() => accounts.id),
    categoryId: integer().references(() => categories.id),
    cadence: text().notNull().default("monthly"), // weekly|biweekly|monthly|quarterly|yearly|irregular
    expectedAmountCents: integer().notNull().default(0),
    lastAmountCents: integer().notNull().default(0),
    lastSeenAt: integer({ mode: "timestamp" }),
    nextExpectedAt: integer({ mode: "timestamp" }),
    occurrences: integer().notNull().default(0),
    status: text().notNull().default("active"), // active|price_changed|missed|canceled|new
    // User's intent for this subscription: keep | cancel | cancelled.
    cancelIntent: text().notNull().default("keep"),
    cancelUrl: text(), // where to actually cancel it
    cancelNote: text(),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [unique("recurring_payee_account_uq").on(t.payeeNormalized, t.accountId)],
);

/** A user-owned dated action, currently used for subscription cancellation plans. */
export const cancellationReminders = sqliteTable(
  "cancellation_reminders",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    dueDate: text().notNull(), // YYYY-MM-DD in the user's local calendar
    note: text(),
    status: text().notNull().default("active"), // active | completed
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
    completedAt: integer({ mode: "timestamp" }),
  },
  (t) => [index("cancellation_reminder_due_idx").on(t.dueDate)],
);

/**
 * Durable context the assistant should not have to rediscover: facts about how
 * money actually moves ("the Roth is funded straight from payroll"), decisions
 * already made, and open questions. `fin brief` renders these into a short
 * primer so a terminal session starts informed instead of re-deriving.
 */
export const notes = sqliteTable(
  "notes",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull().default("fact"), // fact | decision | todo | question | answer
    body: text().notNull(),
    tags: text().notNull().default(""), // comma-separated, lowercase
    // Pinned notes always appear in the brief; the rest age out by recency.
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
    doneAt: integer({ mode: "timestamp" }),
  },
  (t) => [index("note_kind_idx").on(t.kind), index("note_created_idx").on(t.createdAt)],
);

export const appConfig = sqliteTable("app_config", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: "timestamp" }).notNull().default(now),
});

/* ---------------------------------- relations --------------------------------- */

export const institutionsRelations = relations(institutions, ({ many }) => ({
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  institution: one(institutions, {
    fields: [accounts.institutionId],
    references: [institutions.id],
  }),
  transactions: many(transactions),
  snapshots: many(balanceSnapshots),
}));

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  // Self-relation: the purchase a refund reverses, and the refunds against a
  // purchase. Relation-only — the column already exists.
  refundsTransaction: one(transactions, {
    fields: [transactions.refundsTxnId],
    references: [transactions.id],
    relationName: "txn_refunds",
  }),
  refundedBy: many(transactions, { relationName: "txn_refunds" }),
  account: one(accounts, {
    fields: [transactions.accountId],
    references: [accounts.id],
  }),
  category: one(categories, {
    fields: [transactions.categoryId],
    references: [categories.id],
  }),
  recurringSeries: one(recurringSeries, {
    fields: [transactions.recurringSeriesId],
    references: [recurringSeries.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: "category_parent",
  }),
  children: many(categories, { relationName: "category_parent" }),
  transactions: many(transactions),
}));

export const goalsRelations = relations(goals, ({ one, many }) => ({
  linkedAccount: one(accounts, {
    fields: [goals.linkedAccountId],
    references: [accounts.id],
  }),
  parent: one(goals, {
    fields: [goals.parentGoalId],
    references: [goals.id],
    relationName: "goal_parent",
  }),
  children: many(goals, { relationName: "goal_parent" }),
  goalAccounts: many(goalAccounts),
}));

export const goalAccountsRelations = relations(goalAccounts, ({ one }) => ({
  goal: one(goals, {
    fields: [goalAccounts.goalId],
    references: [goals.id],
  }),
  account: one(accounts, {
    fields: [goalAccounts.accountId],
    references: [accounts.id],
  }),
}));

export const netWorthMilestonesRelations = relations(
  netWorthMilestones,
  ({ many }) => ({ lines: many(netWorthMilestoneLines) }),
);

export const netWorthMilestoneLinesRelations = relations(
  netWorthMilestoneLines,
  ({ one }) => ({
    milestone: one(netWorthMilestones, {
      fields: [netWorthMilestoneLines.milestoneId],
      references: [netWorthMilestones.id],
    }),
  }),
);

/* ---------------------------------- types ------------------------------------- */

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type CancellationReminder = typeof cancellationReminders.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type GoalAccount = typeof goalAccounts.$inferSelect;
export type RecurringSeries = typeof recurringSeries.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type NetWorthMilestone = typeof netWorthMilestones.$inferSelect;
export type NewNetWorthMilestone = typeof netWorthMilestones.$inferInsert;
export type NetWorthMilestoneLine = typeof netWorthMilestoneLines.$inferSelect;
export type NewNetWorthMilestoneLine = typeof netWorthMilestoneLines.$inferInsert;
export type LedgerChange = typeof ledgerChanges.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

/* ------------------------ income, business, travel -------------------------- */

/**
 * Where money is earned. `matchPattern` is a case-insensitive substring of the
 * transaction description; deposits that match are attributed to the source,
 * so W-2 pay needs no manual entries at all. `taxTreatment` decides
 * which tax form the income lands on: w2 is already withheld, se is 1099 or
 * other self-employment income (Schedule C, SE tax, SEP room), nontaxable is
 * tracked but never taxed.
 */
export const incomeSourceTreatment = ["w2", "se", "nontaxable"] as const;
export const incomeSources = sqliteTable("income_sources", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique(),
  taxTreatment: text({ enum: incomeSourceTreatment }).notNull().default("se"),
  matchPattern: text(),
  hourlyRateCents: integer(),
  note: text(),
  archived: integer({ mode: "boolean" }).notNull().default(false),
  createdAt: integer({ mode: "timestamp" }).notNull().default(now),
});

/**
 * Work logged against a source: hours or a flat amount for a period of work,
 * and when (and through which deposit) it was paid. `workMonth` is the month
 * the work happened ("YYYY-MM"); `paidOn` is when the money landed. Taxable
 * defaults to the source's treatment but can be overridden per entry (a
 * nontaxable stipend from an otherwise 1099 payer).
 */
export const incomeEntries = sqliteTable(
  "income_entries",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sourceId: integer().notNull().references(() => incomeSources.id, { onDelete: "cascade" }),
    workMonth: text(), // "YYYY-MM"
    workDate: text(), // "YYYY-MM-DD", optional finer grain
    hours: real(),
    rateCents: integer(),
    amountCents: integer().notNull(),
    taxable: integer({ mode: "boolean" }),
    paidOn: text(), // "YYYY-MM-DD"
    txnId: integer(), // the deposit that paid it, when known
    note: text(),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [index("income_entries_source_idx").on(t.sourceId), index("income_entries_txn_idx").on(t.txnId)],
);

/**
 * Business (Schedule C) expenses. `businessPct` is 0-100; the deductible
 * amount is amountCents * businessPct / 100. `datePurchased` may be a range
 * label ("2026-03..2026-12") for subscriptions, so it stays text; `taxYear`
 * is the year it is claimed in.
 */
export const businessExpenses = sqliteTable(
  "business_expenses",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    taxYear: integer().notNull(),
    datePurchased: text(),
    item: text().notNull(),
    amountCents: integer(), // null = price still unknown
    paymentMethod: text(),
    businessPct: integer().notNull().default(100),
    category: text(), // e.g. equipment, software, furniture
    txnId: integer(),
    note: text(),
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [index("business_expenses_year_idx").on(t.taxYear)],
);

/**
 * Points and loyalty accounts: card currencies (Chase Ultimate Rewards) and
 * airline/hotel programs. Member numbers are stored as last 4 only.
 * `valueCentsPerPoint` is a hundredths-of-a-cent valuation (110 = 1.10c).
 */
export const loyaltyKind = ["card", "airline", "hotel", "other"] as const;
export const loyaltyPrograms = sqliteTable("loyalty_programs", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull().unique(),
  kind: text({ enum: loyaltyKind }).notNull(),
  balance: integer().notNull().default(0),
  statusTier: text(),
  memberLast4: text(),
  valueCentsPerPoint: integer(), // hundredths of a cent
  note: text(),
  balanceAsOf: text(), // "YYYY-MM-DD"
  updatedAt: integer({ mode: "timestamp" }).notNull().default(now),
});

/** Booked or past travel: flights, hotels, cars. Imported from email or typed in. */
export const tripKind = ["flight", "hotel", "car", "other"] as const;
export const tripBookings = sqliteTable(
  "trip_bookings",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text({ enum: tripKind }).notNull(),
    provider: text().notNull(), // airline / hotel brand / rental company
    programId: integer().references(() => loyaltyPrograms.id, { onDelete: "set null" }),
    title: text().notNull(), // "SJC → LAX", "La Quinta Springfield"
    startDate: text().notNull(), // "YYYY-MM-DD"
    endDate: text(),
    location: text(),
    costCents: integer(),
    pointsUsed: integer(),
    bookedVia: text(), // direct | chase travel | expedia | ...
    status: text().notNull().default("booked"), // booked | completed | cancelled
    note: text(),
    source: text().notNull().default("manual"), // manual | gmail
    createdAt: integer({ mode: "timestamp" }).notNull().default(now),
  },
  (t) => [index("trip_bookings_start_idx").on(t.startDate)],
);

