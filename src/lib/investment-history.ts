import "server-only";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, holdings, incomeSources, institutions, transactions } from "@/db/schema";
import { isoDate } from "@/lib/format";
import { duplicateContributionLegs, isSweepText } from "@/lib/investment-activity";

/**
 * What was bought, when, and with what money — read off the investment
 * accounts' ledger rows. SimpleFIN gives one cash line per event and nothing
 * else: no share count, no price, no lot, often no ticker (Robinhood names the
 * company, Fidelity frequently only "Investment Buy" or its own name). So
 * quantity and price are always null here, a ticker is filled in only when the
 * name maps to exactly one current holding, and every guess says so.
 */
export type HistoryKind = "buy" | "sell" | "dividend" | "interest" | "contribution" | "transfer-in" | "transfer-out" | "fee" | "other";
export const HISTORY_KINDS: readonly HistoryKind[] = ["buy", "sell", "dividend", "interest", "contribution", "transfer-in", "transfer-out", "fee", "other"];

/** Where money came from (inflows) or went (outflows). `inferred` = matched by amount and date, or assumed from the account type. */
export type Counterparty = { kind: "transfer" | "payroll" | "unknown"; label: string; txnId: number | null; accountId: number | null; inferred: boolean };
export type HistoryEvent = {
  txnId: number; date: string; accountId: number; account: string;
  kind: HistoryKind; label: string;
  /** The security as the institution named it; null when the row does not say. */
  security: string | null; symbol: string | null;
  /** Never in SimpleFIN transaction rows; kept so a UI can show the gap rather than invent a number. */
  quantity: null; priceCents: null;
  /** Size of the event, always positive. `rawAmountCents` is the ledger's signed cash line. */
  amountCents: number; rawAmountCents: number;
  description: string;
  /** "reported": the row's own text says what it is. "inferred": read from a bare payee name and the sign. */
  confidence: "reported" | "inferred";
  fundedBy: Counterparty | null; sentTo: Counterparty | null;
  /** Cash-sweep legs and duplicate rows: real ledger lines, not economic events. Hidden unless asked for. */
  internal: boolean; duplicateOf: number | null;
};
export type SymbolSummary = {
  key: string; symbol: string | null; security: string | null; accounts: string[];
  firstBought: string | null; lastActivity: string | null; buys: number; sells: number;
  investedCents: number; proceedsCents: number; incomeCents: number; netInvestedCents: number;
  /** From today's holdings; null when nothing is held now. */
  shares: number | null; currentValueCents: number | null; brokerCostBasisCents: number | null;
  /**
   * Value + proceeds + income - invested, from the ledger. Only when the ledger plausibly holds the whole
   * position: a ticker is known, a buy is on record, nothing was sold before the first buy, and the
   * broker's cost basis is not more than the ledger's net investment (5% / $1 slack). Otherwise null.
   */
  ledgerGainCents: number | null;
  /** Value - broker cost basis. Null when the broker gives no basis (crypto). */
  brokerGainCents: number | null;
};
export type AccountSummary = {
  accountId: number; account: string; type: string; institution: string | null; balanceCents: number;
  firstActivity: string | null; events: number; holdings: number;
} & Record<"contributionCents" | "transferInCents" | "transferOutCents" | "boughtCents" | "soldCents" | "dividendCents" | "interestCents" | "feeCents", number>;
/** Money that came into one account, grouped by where it came from. */
export type FundingSource = { accountId: number; account: string; kind: Counterparty["kind"]; label: string; inferred: boolean; amountCents: number; count: number };
export type InvestmentHistory = {
  filter: HistoryFilter; events: HistoryEvent[]; hiddenInternal: number;
  symbols: SymbolSummary[]; accounts: AccountSummary[]; funding: FundingSource[]; limits: string[];
};
export type HistoryFilter = { accountId?: number; symbol?: string; kind?: HistoryKind; from?: string; to?: string; includeInternal?: boolean };

export type LedgerRow = { id: number; accountId: number; date: string; amountCents: number; text: string; categoryKind: string | null; isTransfer: boolean; transferPairTxnId: number | null };
export type AccountMeta = { id: number; name: string; type: string; institution: string | null; balanceCents: number };
export type HeldPosition = { accountId: number; symbol: string | null; description: string | null; shares: number; marketValueCents: number; costPerShareCents: number | null };
export type CounterRow = { id: number; accountId: number; account: string; date: string; amountCents: number; text: string; isTransfer: boolean };

const TRADE = /^(buy|sell)\s+(?:(?:x|[\d.,]+)\s+)?(?:shares\s+of\s+)?(.*?)\s*(?:for each)?$/i;
const PAIR_DAYS = 5;
const DAY_MS = 86_400_000;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
/** "Robinhood" from "Robinhood", "fidelity" from "Fidelity Investments": how the bank side names it. */
const keyword = (institution: string | null) => institution?.split(/\s+/)[0].toLowerCase() ?? null;

type Classified = Pick<HistoryEvent, "kind" | "label" | "security" | "confidence" | "internal">;

/** Pure: what one investment-account ledger row was. */
export function classifyRow(row: Pick<LedgerRow, "text" | "amountCents" | "categoryKind" | "isTransfer">, institution: string | null): Classified {
  const text = row.text.trim();
  const out = row.amountCents > 0;
  const base = { security: null, confidence: "reported" as const, internal: false };
  const trade = TRADE.exec(text);
  if (trade) {
    const kind = trade[1].toLowerCase() === "buy" ? "buy" : "sell";
    return { ...base, kind, label: kind === "buy" ? "Buy" : "Sell", security: trade[2] || null };
  }
  if (/^investment (buy|sell)$/i.test(text)) return { ...base, kind: /buy/i.test(text) ? "buy" : "sell", label: /buy/i.test(text) ? "Buy" : "Sell" };
  if (/contribution|partic contr/i.test(text)) return { ...base, kind: "contribution", label: "Contribution" };
  if (/withdrawal|distribution|disbursement/i.test(text)) return { ...base, kind: "transfer-out", label: "Withdrawal" };
  if (/dividend|capital gain/i.test(text)) return { ...base, kind: "dividend", label: "Dividend" };
  if (/interest/i.test(text)) return { ...base, kind: "interest", label: "Interest" };
  if (/foreign tax|\bfees?\b|commission/i.test(text)) return { ...base, kind: "fee", label: "Fee" };
  if (isSweepText(text)) return { ...base, kind: "other", label: "Cash sweep (the institution gives no detail)", internal: true };
  if (row.isTransfer || row.categoryKind === "transfer" || /transfer|deposit|\beft\b|\bach\b/i.test(text) || text.toLowerCase() === keyword(institution)) {
    return { ...base, kind: out ? "transfer-in" : "transfer-out", label: out ? "Deposit" : "Transfer out" };
  }
  // A bare company name: money out is almost certainly a purchase of it, money in a sale — but nothing on the row says so.
  return { ...base, kind: out ? "sell" : "buy", label: out ? "Sell (inferred)" : "Buy (inferred)", security: text || null, confidence: "inferred" };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]/g, " ").replace(/\b(inc|corp|corporation|co|ltd|plc|adr|nv|sa|etf|the|class [a-c])\b/g, " ").replace(/\s+/g, " ").trim();

/** Pure: the ticker for a named security, only when exactly one held symbol fits. */
export function resolveSymbol(security: string | null, held: Pick<HeldPosition, "symbol" | "description">[]): string | null {
  if (!security) return null;
  const n = norm(security);
  if (!n) return null;
  const first = n.split(" ")[0];
  const hits = new Set<string>();
  for (const h of held) {
    if (!h.symbol) continue;
    const sym = h.symbol.toLowerCase(), d = norm(h.description ?? "");
    if (n === sym || first === sym || (d && (d.startsWith(n) || n.startsWith(d)))) hits.add(h.symbol.toUpperCase());
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** Pure: a contribution reported twice on one day (once as a negative cash leg, once positive) is one contribution. */
export function markDuplicates(events: HistoryEvent[]): void {
  const contributions = events.filter((e) => e.kind === "contribution");
  const dropped = duplicateContributionLegs(contributions.map((e) => ({ id: e.txnId, accountId: e.accountId, day: e.date, amountCents: e.rawAmountCents })));
  for (const e of contributions) {
    const kept = dropped.get(e.txnId);
    if (kept != null) { e.duplicateOf = kept; e.internal = true; }
  }
}

const PAYROLL_ACCOUNT = /\b401\s?\(?k\)?|\b403\s?\(?b\)?|\b457\b/i;

/** Pure: pair inflows with the outflow that paid them, and outflows with where they landed. */
export function attachCounterparties(events: HistoryEvent[], meta: Map<number, AccountMeta>, counter: CounterRow[], employers: string[]): void {
  const used = new Set<number>();
  const unknown = (why: string): Counterparty => ({ kind: "unknown", label: why, txnId: null, accountId: null, inferred: false });
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date) || a.txnId - b.txnId)) {
    const inflow = e.kind === "contribution" || e.kind === "transfer-in";
    if (e.internal || (!inflow && e.kind !== "transfer-out")) continue;
    const kw = keyword(meta.get(e.accountId)?.institution ?? null);
    const want = inflow ? -e.amountCents : e.amountCents;
    const match = counter
      .filter((c) => !used.has(c.id) && c.accountId !== e.accountId && c.amountCents === want && Math.abs(dayDiff(e.date, c.date)) <= PAIR_DAYS)
      // A sweep leg in another account at the same institution ("Fidelity") is not the bank side of anything.
      .filter((c) => !isSweepText(c.text) && ((kw && c.text.toLowerCase().includes(kw)) || (!inflow && c.isTransfer)))
      .sort((a, b) => Math.abs(dayDiff(e.date, a.date)) - Math.abs(dayDiff(e.date, b.date)) || a.id - b.id)[0];
    let party: Counterparty;
    if (match) {
      used.add(match.id);
      party = { kind: "transfer", label: `${inflow ? "transfer from" : "to"} ${match.account}`, txnId: match.id, accountId: match.accountId, inferred: true };
    } else if (inflow && e.kind === "contribution" && PAYROLL_ACCOUNT.test(e.account)) {
      const employer = employers.find((n) => e.account.toLowerCase().includes(n.toLowerCase()));
      party = { kind: "payroll", label: `payroll${employer ? ` (${employer})` : ""}`, txnId: null, accountId: null, inferred: true };
    } else {
      party = unknown(inflow ? "unknown — no matching outflow in a linked account" : "unknown — no matching inflow in a linked account");
    }
    if (inflow) e.fundedBy = party; else e.sentTo = party;
  }
}

/** Pure: build, de-duplicate, pair. Rows are one account's ledger lines; `held` is today's positions. */
export function buildEvents(rows: LedgerRow[], meta: Map<number, AccountMeta>, held: HeldPosition[], counter: CounterRow[], employers: string[]): HistoryEvent[] {
  const pairs = new Map(rows.flatMap((r) => (r.transferPairTxnId != null ? [[r.id, r.transferPairTxnId] as [number, number]] : [])));
  const events: HistoryEvent[] = rows.map((r) => {
    const a = meta.get(r.accountId)!;
    const c = classifyRow(r, a.institution);
    return {
      txnId: r.id, date: r.date, accountId: r.accountId, account: a.name, ...c,
      symbol: resolveSymbol(c.security, held), quantity: null, priceCents: null,
      amountCents: Math.abs(r.amountCents), rawAmountCents: r.amountCents, description: r.text,
      fundedBy: null, sentTo: null, duplicateOf: null,
    };
  });
  markDuplicates(events);
  // A user-declared transfer pair wins over any amount-and-date guess.
  for (const e of events) {
    const pairId = pairs.get(e.txnId);
    const other = pairId != null ? counter.find((c) => c.id === pairId) : undefined;
    if (!other) continue;
    const party: Counterparty = { kind: "transfer", label: `${e.rawAmountCents > 0 ? "transfer from" : "to"} ${other.account}`, txnId: other.id, accountId: other.accountId, inferred: false };
    if (e.rawAmountCents > 0) e.fundedBy = party; else e.sentTo = party;
  }
  const unpaired = events.filter((e) => !e.fundedBy && !e.sentTo);
  const claimed = new Set(events.flatMap((e) => [e.fundedBy?.txnId, e.sentTo?.txnId]).filter((x): x is number => x != null));
  attachCounterparties(unpaired, meta, counter.filter((c) => !claimed.has(c.id)), employers);
  return events.sort((a, b) => b.date.localeCompare(a.date) || b.txnId - a.txnId);
}

