/**
 * Pure config constants — safe to import from scripts (Bun) and client code.
 * The DB-backed getters/setters live in `config.ts` (server-only).
 * Money values are integer-cents strings to match the rest of the app.
 */
export const CONFIG_DEFAULTS = {
  roth_limit_cents: "750000", // 2026 Roth IRA contribution limit ($7,500)
  emergency_target_cents: "500000", // $5,000 emergency fund target
  fcf_lookback_months: "3", // months of history used to estimate free cash flow
  monthly_income_cents: "", // optional manual override of estimated income
  // Single all-in monthly spending budget. Drives the daily allowance shown on
  // the phone home screen; empty means the user has not set one yet.
  monthly_budget_cents: "",
  hide_cash_from_net_worth: "0", // "1" = exclude the Cash account from net worth by default
  hide_zero_accounts: "0", // "1" = hide accounts with a $0 balance from lists/dropdowns
  // Comma-separated route keys for optional sidebar destinations.
  sidebar_visible_tabs: "overview,accounts,cash,transactions,spending,earnings,investments,holdings,transfers,refunds,upcoming,recurring,reminders,goals,future-plan,planning,taxes,research",
  // User-authored what-if assumptions for Future plan. This is deliberately
  // separate from imported balances and transaction analytics.
  future_plan: "",
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;
