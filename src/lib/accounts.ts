import { differenceInCalendarDays } from "date-fns";
import type { AccountType } from "@/db/schema";

export const ACCOUNT_TYPE_META: Record<
  AccountType,
  { label: string; icon: string; isAsset: boolean }
> = {
  checking: { label: "Checking", icon: "wallet", isAsset: true },
  savings: { label: "Savings", icon: "piggy-bank", isAsset: true },
  hysa: { label: "HYSA", icon: "piggy-bank", isAsset: true },
  hsa: { label: "HSA", icon: "heart-pulse", isAsset: true },
  credit: { label: "Credit Card", icon: "credit-card", isAsset: false },
  brokerage: { label: "Brokerage", icon: "chart-line", isAsset: true },
  ira: { label: "Retirement", icon: "landmark", isAsset: true },
  crypto: { label: "Crypto", icon: "bitcoin", isAsset: true },
  cash: { label: "Cash", icon: "banknote", isAsset: true },
  loan: { label: "Loan", icon: "hand-coins", isAsset: false },
  other: { label: "Other", icon: "wallet", isAsset: true },
};

export const isLiability = (type: AccountType): boolean =>
  !ACCOUNT_TYPE_META[type].isAsset;

/**
 * Best-effort account-type inference. SimpleFIN/MX don't return a reliable type,
 * so we classify from the account + institution name (and whether it holds
 * securities). Order matters: retirement and brokerage are checked first.
 */
export function inferAccountType(
  name: string,
  orgName: string,
  hasHoldings = false,
): AccountType {
  const s = `${name} ${orgName}`.toLowerCase();

  // Explicit account-name keywords win over the holdings signal, so a savings
  // account that happens to report holdings isn't misread as a brokerage.
  // Providers write the plan name as "401(K)" as often as "401k".
  if (/\b(roth|ira|retirement)\b|401\s?\(?k\)?|403\s?\(?b\)?/.test(s)) return "ira";
  if (/\b(crypto|bitcoin|coinbase|kraken|binance|ethereum)\b/.test(s))
    return "crypto";
  if (
    /\b(credit|card|discover it|platinum|sapphire|freedom|amex|visa|mastercard)\b/.test(
      s,
    )
  )
    return "credit";
  if (/\b(checking|chk|spending|cash management|cash account)\b/.test(s))
    return "checking";
  if (/\bhsa\b|health\s+savings/.test(s)) return "hsa";
  if (/\b(hysa|high[\s-]?yield)\b/.test(s)) return "hysa";
  if (/\bsavings?\b|\bsave\b/.test(s)) return "savings";
  if (/\b(loan|mortgage)\b/.test(s)) return "loan";
  if (
    hasHoldings ||
    /\b(robinhood|brokerage|invest|securities|schwab|etrade|e\*trade|vanguard|webull)\b/.test(
      s,
    )
  )
    return "brokerage";
  return "other";
}

/**
 * Days of drift after which a provider-reported balance stops being trustworthy
 * as "current". Chosen to tolerate a weekend of no refresh without crying wolf.
 */
export const STALE_BALANCE_DAYS = 3;

/**
 * How old the *provider's* figure is for an account. Driven by `balanceDate`,
 * not `lastSyncedAt` — a stalled connection still answers every sync, so the
 * only honest measure of freshness is when the provider last saw the balance
 * move. Returns null for accounts with no provider date (manual entries).
 */
export function balanceAge(
  balanceDate: Date | null | undefined,
): { days: number; isStale: boolean } | null {
  if (!balanceDate) return null;
  const days = Math.max(0, differenceInCalendarDays(new Date(), balanceDate));
  return { days, isStale: days >= STALE_BALANCE_DAYS };
}
