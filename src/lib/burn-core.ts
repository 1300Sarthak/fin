/**
 * Pure classification core for the earned / spent / burn-rate engine.
 *
 * `lib/spending.ts` answers "what moved through my spendable accounts this
 * month". That is the right question for budgeting and it deliberately drops
 * every investment account. It is the wrong question for "how much did I
 * actually make", because a paycheck can be direct-deposited straight into a
 * brokerage and never touch a bank: some brokerages record that as a
 * *negative* ledger row inside the IRA, so a naive read shows the income
 * vanishing.
 *
 * This module reconstructs household cash flow instead:
 *   money in   = anything arriving from outside every tracked account
 *   money out  = anything leaving to a party that is not one of those accounts
 *   internal   = both legs land in tracked accounts, so it nets to zero
 *
 * Every classification is recorded on the row so `fin burn --explain` can show
 * its work. Nothing here is hardcoded to a specific merchant or account.
 *
 * Kept free of database imports so the rules can be tested on fixtures.
 */
import { classifyInvestmentActivity } from "@/lib/investment-activity";

const INVESTMENT_TYPES = new Set(["brokerage", "ira", "crypto", "retirement"]);

/** Days either side of a transaction to look for its internal counterpart. */
export const PAIR_WINDOW_DAYS = 4;

/**
 * Text that makes a row a plausible leg of an account-to-account move. The
 * institution names are here because brokerages and neobanks often label a
 * transfer with nothing but their own name; extend the list for yours.
 */
const TRANSFER_HINT =
  /transfer|payment|credit card|contribution|deposit|withdrawal|wire|\bach\b|robinhood|fidelity|schwab|vanguard|betterment|wealthfront|sofi|ally|marcus|chime|onepay|venmo transfer/i;

/**
 * Person-to-person and wallet rails. The counterparty is a human or an
 * untracked wallet, so an equal-and-opposite amount elsewhere in the same week
 * is a coincidence, not the other leg. Without this guard a $20 Zelle to a
 * friend can silently cancel an unrelated $20 deposit.
 */
const EXTERNAL_RAIL = /zelle|venmo|cash app|paypal|apple pay|apple cash/i;

export type FlowKind =
  | "income" // arrived from outside, spendable
  | "contribution" // arrived from outside, straight into an investment account
  | "pretax" // employer-side money that never hit a bank (401k)
  | "spend" // left to an outside party
  | "refund" // money back on an earlier purchase, or a card credit
  | "reimbursement" // someone paid you back for something you fronted
  | "internal" // both legs tracked: transfer, card payoff, brokerage funding
  | "market" // trades and dividends inside an investment account
  | "excluded"; // user said "don't count this"

export type FlowRow = {
  id: number;
  date: string;
  month: string;
  accountId: number;
  account: string;
  accountType: string;
  isLiability: boolean;
  amountCents: number;
  /** Cash-flow direction after normalising provider sign quirks. */
  econCents: number;
  merchant: string;
  category: string | null;
  categoryKind: string | null;
  kind: FlowKind;
  /** Why it landed in that bucket — surfaced by `--explain`. */
  reason: string;
  /** The transaction this was paired against, when internal. */
  pairedWith?: number;
};

export type Raw = {
  id: number;
  accountId: number;
  postedAt: Date;
  amountCents: number;
  merchantRaw: string;
  isTransfer: boolean;
  isRefund: boolean;
  isExcluded: boolean;
  account: string;
  accountType: string;
  isAsset: boolean;
  category: string | null;
  categoryKind: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (d: Date) => iso(d).slice(0, 7);
const days = (a: Date, b: Date) =>
  Math.abs(a.getTime() - b.getTime()) / 86_400_000;

const isInvestment = (r: Raw) => INVESTMENT_TYPES.has(r.accountType);

const investmentKind = (r: Raw) =>
  classifyInvestmentActivity({
    merchantRaw: r.merchantRaw,
    categoryName: r.category,
    categoryKind: r.categoryKind,
  }).kind;

/**
 * The signed amount in cash-flow terms: positive means money arrived in this
 * account. Brokerages do not agree on a convention — some book an incoming
 * contribution as a negative row — so the description decides the
 * direction and the stored sign is only a fallback.
 */
function economicCents(r: Raw): number {
  if (isInvestment(r)) {
    const kind = investmentKind(r);
    if (kind === "contribution") return Math.abs(r.amountCents);
    if (kind === "withdrawal") return -Math.abs(r.amountCents);
  }
  return r.amountCents;
}

/** Could this row be one leg of a move between two accounts the user owns? */
function pairable(r: Raw): boolean {
  if (EXTERNAL_RAIL.test(r.merchantRaw)) return false;
  return (
    r.categoryKind === "transfer" ||
    isInvestment(r) ||
    TRANSFER_HINT.test(r.merchantRaw)
  );
}

/**
 * Match equal-and-opposite legs across two different tracked accounts.
 *
 * Signs cannot be trusted on their own: a brokerage may report an incoming
 * contribution as negative. Magnitude plus proximity plus a transfer-shaped
 * description is what identifies a pair, so both directions are tried.
 */
function pairInternal(rows: Raw[]): Map<number, number> {
  const paired = new Map<number, number>();
  const taken = new Set<number>();
  const candidates = rows.filter((r) => !r.isExcluded && pairable(r));

  const byAmount = new Map<number, Raw[]>();
  for (const r of candidates) {
    const key = Math.abs(r.amountCents);
    const list = byAmount.get(key);
    if (list) list.push(r);
    else byAmount.set(key, [r]);
  }

  for (const list of byAmount.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      if (taken.has(a.id)) continue;
      const mate = list.find(
        (b) =>
          b.id !== a.id &&
          !taken.has(b.id) &&
          b.accountId !== a.accountId &&
          // One leg out, one leg in, using the economic direction rather than
          // the raw sign the institution happened to report.
          Math.sign(economicCents(a)) !== Math.sign(economicCents(b)) &&
          days(a.postedAt, b.postedAt) <= PAIR_WINDOW_DAYS,
      );
      if (!mate) continue;
      taken.add(a.id);
      taken.add(mate.id);
      paired.set(a.id, mate.id);
      paired.set(mate.id, a.id);
    }
  }
  return paired;
}

/**
 * Dividend reinvestment and cash sweeps post as two rows on the same day in
 * the same account: the credit, then the purchase that consumes it. They net
 * to nothing, so neither is income nor spending.
 */
function selfNetted(rows: Raw[]): Set<number> {
  const out = new Set<number>();
  const seen = new Map<string, Raw>();
  for (const r of rows) {
    if (!isInvestment(r)) continue;
    const key = `${r.accountId}|${iso(r.postedAt)}|${Math.abs(r.amountCents)}`;
    const prior = seen.get(key);
    if (prior && Math.sign(prior.amountCents) !== Math.sign(r.amountCents)) {
      out.add(prior.id);
      out.add(r.id);
      seen.delete(key);
    } else {
      seen.set(key, r);
    }
  }
  return out;
}

function classify(
  r: Raw,
  paired: Map<number, number>,
  netted: Set<number>,
): Pick<FlowRow, "kind" | "reason" | "pairedWith"> {
  if (r.isExcluded) return { kind: "excluded", reason: "marked excluded" };

  const mate = paired.get(r.id);
  if (r.isTransfer) {
    return { kind: "internal", reason: "flagged as a transfer", pairedWith: mate };
  }
  if (mate !== undefined) {
    return { kind: "internal", reason: `matched txn #${mate}`, pairedWith: mate };
  }

  if (isInvestment(r)) {
    if (netted.has(r.id)) {
      return { kind: "market", reason: "reinvestment leg, nets out same day" };
    }
    const kind = investmentKind(r);
    if (kind === "contribution") {
      // No matching outflow from a tracked account, so the cash came from
      // outside — a payroll direct deposit into the investment account.
      const pretax = /401\s?\(?k\)?/i.test(r.account);
      return {
        kind: pretax ? "pretax" : "contribution",
        reason: "contribution with no funding leg in a tracked account",
      };
    }
    if (kind === "trade" || kind === "investment_income" || r.categoryKind === "investment") {
      return { kind: "market", reason: `${kind} inside the account` };
    }
    // Fees, withdrawals and ordinary card activity on a brokerage still move
    // real money, so fall through to the sign-based rules below.
  }

  if (r.isRefund) return { kind: "refund", reason: "flagged as a refund" };

  if (r.amountCents > 0) {
    // Money arriving over a person-to-person rail is somebody settling up for
    // something already bought, so it belongs against spending rather than in
    // earnings. Genuine gifts and payroll arrive under their own name.
    if (EXTERNAL_RAIL.test(r.merchantRaw)) {
      return { kind: "reimbursement", reason: "paid back over a P2P rail" };
    }
    // On a credit card a positive row is a credit against the balance, not
    // earnings — unless it is genuinely income, like a cashback payout.
    if (!r.isAsset && r.categoryKind !== "income") {
      return { kind: "refund", reason: "credit posted to a card" };
    }
    return { kind: "income", reason: "money in from outside" };
  }

  return { kind: "spend", reason: "money out to an outside party" };
}

export type MonthFlow = {
  month: string;
  incomeCents: number;
  contributionCents: number;
  pretaxCents: number;
  takeHomeCents: number;
  earnedCents: number;
  grossSpendCents: number;
  refundCents: number;
  reimbursementCents: number;
  netSpendCents: number;
  cashSpendCents: number;
  savedCents: number;
  burnPct: number;
  burnExCashPct: number;
  savingsRatePct: number;
};

export type BurnReport = {
  months: MonthFlow[];
  total: MonthFlow;
  rows: FlowRow[];
};

const pct = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100);

function fold(month: string, rows: FlowRow[]): MonthFlow {
  const sum = (k: FlowKind, f: (r: FlowRow) => number = (r) => Math.abs(r.amountCents)) =>
    rows.filter((r) => r.kind === k).reduce((s, r) => s + f(r), 0);

  const incomeCents = sum("income");
  const contributionCents = sum("contribution");
  const pretaxCents = sum("pretax");
  const grossSpendCents = sum("spend");
  const refundCents = sum("refund");
  const reimbursementCents = sum("reimbursement");
  const cashSpendCents = rows
    .filter((r) => r.kind === "spend" && r.accountType === "cash")
    .reduce((s, r) => s + Math.abs(r.amountCents), 0);

  const takeHomeCents = incomeCents + contributionCents;
  const earnedCents = takeHomeCents + pretaxCents;
  const netSpendCents = grossSpendCents - refundCents - reimbursementCents;

  return {
    month,
    incomeCents,
    contributionCents,
    pretaxCents,
    takeHomeCents,
    earnedCents,
    grossSpendCents,
    refundCents,
    reimbursementCents,
    netSpendCents,
    cashSpendCents,
    savedCents: takeHomeCents - netSpendCents,
    burnPct: pct(netSpendCents, takeHomeCents),
    burnExCashPct: pct(netSpendCents - cashSpendCents, takeHomeCents),
    savingsRatePct: pct(takeHomeCents - netSpendCents, takeHomeCents),
  };
}

export type Allocation = { name: string; cents: number; pct: number };

/**
 * Where the earned money ended up. Investment destinations come from the flow
 * rows; the cash line is whatever is left over, which also absorbs any
 * balance drift the ledger cannot see.
 */
export function allocate(report: BurnReport): Allocation[] {
  const byAccount = new Map<string, number>();
  for (const r of report.rows) {
    if (r.kind !== "contribution" && r.kind !== "pretax") continue;
    byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + Math.abs(r.amountCents));
  }
  // Cash the user moved into a brokerage themselves is saving too, even though
  // it nets to zero across accounts.
  const fundedInvesting = report.rows
    .filter((r) => r.kind === "internal" && INVESTMENT_TYPES.has(r.accountType))
    .reduce((s, r) => s + r.econCents, 0);

  const t = report.total;
  const rest = t.earnedCents - t.netSpendCents - [...byAccount.values()].reduce((s, v) => s + v, 0) - fundedInvesting;

  const items: Allocation[] = [
    { name: "Lived on (net spending)", cents: t.netSpendCents, pct: 0 },
    ...[...byAccount.entries()].map(([name, cents]) => ({ name, cents, pct: 0 })),
  ];
  if (fundedInvesting !== 0) items.push({ name: "Moved into investing", cents: fundedInvesting, pct: 0 });
  items.push({ name: "Left in cash / paid down cards", cents: rest, pct: 0 });

  return items
    .filter((i) => Math.round(i.cents) !== 0)
    .map((i) => ({ ...i, pct: pct(i.cents, t.earnedCents) }))
    .sort((a, b) => b.cents - a.cents);
}

/**
 * Classify a window of rows and fold them into per-month totals. `start`/`end`
 * bound what is reported; rows outside are still passed in so a transfer that
 * straddles the boundary can find its counterpart.
 */
export function buildReport(raw: Raw[], start: Date, end: Date, label: string): BurnReport {
  const paired = pairInternal(raw);
  const netted = selfNetted(raw);
  const rows: FlowRow[] = raw
    .filter((r) => r.postedAt >= start && r.postedAt <= end)
    .map((r) => ({
      id: r.id,
      date: iso(r.postedAt),
      month: monthOf(r.postedAt),
      accountId: r.accountId,
      account: r.account,
      accountType: r.accountType,
      isLiability: !r.isAsset,
      amountCents: r.amountCents,
      econCents: economicCents(r),
      merchant: r.merchantRaw,
      category: r.category,
      categoryKind: r.categoryKind,
      ...classify(r, paired, netted),
    }));

  const monthKeys = [...new Set(rows.map((r) => r.month))].sort();
  return {
    months: monthKeys.map((m) => fold(m, rows.filter((r) => r.month === m))),
    total: fold(monthKeys.length > 1 ? `${monthKeys[0]}..${monthKeys.at(-1)}` : label, rows),
    rows,
  };
}
