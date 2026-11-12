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

/** Pure: per-security totals from the events, valued with today's holdings. */
export function summarizeSymbols(events: HistoryEvent[], held: HeldPosition[], meta: Map<number, AccountMeta>): SymbolSummary[] {
  const out = new Map<string, SymbolSummary>();
  const get = (symbol: string | null, security: string | null) => {
    const key = symbol ?? security ?? "(unnamed)";
    let s = out.get(key);
    if (!s) {
      s = { key, symbol, security, accounts: [], firstBought: null, lastActivity: null, buys: 0, sells: 0, investedCents: 0, proceedsCents: 0, incomeCents: 0, netInvestedCents: 0, shares: null, currentValueCents: null, brokerCostBasisCents: null, ledgerGainCents: null, brokerGainCents: null };
      out.set(key, s);
    }
    return s;
  };
  for (const e of events) {
    if (e.internal || !(e.kind === "buy" || e.kind === "sell" || ((e.kind === "dividend" || e.kind === "interest") && e.security))) continue;
    const s = get(e.symbol, e.security);
    if (!s.accounts.includes(e.account)) s.accounts.push(e.account);
    if (!s.lastActivity || e.date > s.lastActivity) s.lastActivity = e.date;
    if (e.kind === "buy") { s.buys++; s.investedCents += e.amountCents; if (!s.firstBought || e.date < s.firstBought) s.firstBought = e.date; }
    else if (e.kind === "sell") { s.sells++; s.proceedsCents += e.amountCents; }
    else s.incomeCents += e.amountCents;
  }
  for (const h of held) {
    if (!h.symbol) continue;
    const s = get(h.symbol.toUpperCase(), h.description);
    s.security ??= h.description;
    const name = meta.get(h.accountId)?.name;
    if (name && !s.accounts.includes(name)) s.accounts.push(name);
    s.shares = (s.shares ?? 0) + h.shares;
    s.currentValueCents = (s.currentValueCents ?? 0) + h.marketValueCents;
    if (h.costPerShareCents) s.brokerCostBasisCents = (s.brokerCostBasisCents ?? 0) + Math.round(h.costPerShareCents * h.shares);
  }
  const firstSell = new Map<string, string>();
  for (const e of events) {
    if (e.internal || e.kind !== "sell") continue;
    const key = e.symbol ?? e.security ?? "(unnamed)";
    if (!firstSell.has(key) || e.date < firstSell.get(key)!) firstSell.set(key, e.date);
  }
  for (const s of out.values()) {
    s.netInvestedCents = s.investedCents - s.proceedsCents;
    const sell = firstSell.get(s.key);
    const complete = s.symbol != null && s.firstBought != null && (!sell || sell >= s.firstBought) &&
      (s.brokerCostBasisCents == null || s.brokerCostBasisCents <= s.netInvestedCents * 1.05 + 100);
    s.ledgerGainCents = complete ? (s.currentValueCents ?? 0) + s.proceedsCents + s.incomeCents - s.investedCents : null;
    s.brokerGainCents = s.currentValueCents != null && s.brokerCostBasisCents ? s.currentValueCents - s.brokerCostBasisCents : null;
  }
  return [...out.values()].sort((a, b) => (b.currentValueCents ?? 0) - (a.currentValueCents ?? 0) || b.investedCents - a.investedCents);
}

const ACCOUNT_KEYS: Partial<Record<HistoryKind, keyof AccountSummary>> = {
  contribution: "contributionCents", "transfer-in": "transferInCents", "transfer-out": "transferOutCents",
  buy: "boughtCents", sell: "soldCents", dividend: "dividendCents", interest: "interestCents", fee: "feeCents",
};

export function summarizeAccounts(events: HistoryEvent[], meta: AccountMeta[], held: HeldPosition[]): AccountSummary[] {
  return meta.map((a) => {
    const mine = events.filter((e) => e.accountId === a.id && !e.internal);
    const s: AccountSummary = {
      accountId: a.id, account: a.name, type: a.type, institution: a.institution, balanceCents: a.balanceCents,
      firstActivity: mine.reduce<string | null>((m, e) => (m == null || e.date < m ? e.date : m), null), events: mine.length,
      holdings: held.filter((h) => h.accountId === a.id).length,
      contributionCents: 0, transferInCents: 0, transferOutCents: 0, boughtCents: 0, soldCents: 0, dividendCents: 0, interestCents: 0, feeCents: 0,
    };
    for (const e of mine) { const k = ACCOUNT_KEYS[e.kind]; if (k) (s[k] as number) += e.amountCents; }
    return s;
  });
}

/** Pure: contributions and deposits per account, grouped by what funded them; largest first. Internal rows are skipped. */
export function summarizeFunding(events: HistoryEvent[]): FundingSource[] {
  const out = new Map<string, FundingSource>();
  for (const e of events) {
    if (e.internal || (e.kind !== "contribution" && e.kind !== "transfer-in")) continue;
    const by = e.fundedBy ?? { kind: "unknown" as const, label: "unknown — not paired", inferred: false };
    const key = `${e.accountId}|${by.label}`;
    const row = out.get(key) ?? { accountId: e.accountId, account: e.account, kind: by.kind, label: by.label, inferred: by.inferred, amountCents: 0, count: 0 };
    row.amountCents += e.amountCents;
    row.count++;
    row.inferred ||= by.inferred;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => a.accountId - b.accountId || b.amountCents - a.amountCents);
}

/**
 * Pure: narrow the full history to a filter. The timeline honours every filter; account totals ignore `kind`;
 * per-security totals also ignore from/to, because "first bought" and the gain are lifetime facts.
 */
export function applyFilter(all: HistoryEvent[], held: HeldPosition[], meta: AccountMeta[], f: HistoryFilter): InvestmentHistory {
  const sym = f.symbol?.trim().toLowerCase();
  const lifetime = all.filter((e) => (f.accountId == null || e.accountId === f.accountId) && (!sym || e.symbol?.toLowerCase() === sym || e.security?.toLowerCase() === sym));
  const scoped = lifetime.filter((e) => (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to));
  const heldScoped = held.filter((h) => (f.accountId == null || h.accountId === f.accountId) && (!sym || h.symbol?.toLowerCase() === sym));
  const metaScoped = meta.filter((a) => f.accountId == null || a.id === f.accountId);
  const kinded = scoped.filter((e) => !f.kind || e.kind === f.kind);
  const events = f.includeInternal ? kinded : kinded.filter((e) => !e.internal);
  const limits = [
    "Rows carry no share count, price or lot: quantity and priceCents are always null. Current shares and average cost come from today's holdings, not from the trades.",
    "Holdings are a single snapshot replaced on every sync; there is no position history, so value on a past date is unknown.",
    "Tickers are filled in only when the institution's name for a security matches exactly one current holding; sold-out positions usually stay unnamed.",
    "Funding is matched by equal amount within 5 days and the institution's name on the bank side; payroll is assumed for 401(k)/403(b) contributions. Anything else is \"unknown\".",
    "Fidelity reports many rows only as \"Fidelity\" (money-market sweep legs); they are hidden as internal, and so a Fidelity buy often appears as \"Investment Buy\" with no security named.",
  ];
  for (const a of metaScoped) {
    if (!all.some((e) => e.accountId === a.id) && held.some((h) => h.accountId === a.id)) limits.push(`${a.name} holds positions but has no transactions on record — how they were bought is unknown.`);
  }
  const ledgerStart = all.reduce<string | null>((m, e) => (m == null || e.date < m ? e.date : m), null);
  if (ledgerStart) limits.push(`The investment ledger starts ${ledgerStart}; anything bought earlier has a value but no purchase on record.`);
  return {
    filter: f, events, hiddenInternal: kinded.length - events.length,
    symbols: summarizeSymbols(lifetime, heldScoped, new Map(meta.map((a) => [a.id, a]))),
    accounts: summarizeAccounts(scoped, metaScoped, heldScoped),
    funding: summarizeFunding(scoped),
    limits,
  };
}

const FLOW_KEYS = ["contributionCents", "transferInCents", "transferOutCents", "boughtCents", "soldCents", "dividendCents", "interestCents", "feeCents"] as const;
/** Portfolio-wide money in and out for a history's range: its accounts' totals summed. */
export type InvestmentFlows = Record<(typeof FLOW_KEYS)[number], number>;

export function investmentFlows(h: Pick<InvestmentHistory, "accounts">): InvestmentFlows {
  return Object.fromEntries(FLOW_KEYS.map((k) => [k, h.accounts.reduce((s, a) => s + a[k], 0)])) as InvestmentFlows;
}

/** The figures the /investments page shows for a range and `fin investments` prints; both read them here. */
export async function getInvestmentFlows(span: { from?: string; to?: string }): Promise<InvestmentFlows> {
  return investmentFlows(await getInvestmentHistory({ from: span.from, to: span.to, includeInternal: true }));
}

const INVESTMENT_TYPES = ["brokerage", "ira", "crypto", "hsa"] as const;

/** Investment accounts by type, plus any other account that holds positions (e.g. a cash-management account in a money market fund). */
export async function getInvestmentHistory(filter: HistoryFilter = {}): Promise<InvestmentHistory> {
  const [acctRows, held, sources] = await Promise.all([
    db.select({ id: accounts.id, name: accounts.name, type: accounts.type, institution: institutions.name, balanceCents: accounts.currentBalanceCents })
      .from(accounts).leftJoin(institutions, eq(institutions.id, accounts.institutionId)),
    db.select({ accountId: holdings.accountId, symbol: holdings.symbol, description: holdings.description, shares: holdings.shares, marketValueCents: holdings.marketValueCents, costPerShareCents: holdings.costPerShareCents }).from(holdings),
    db.select({ name: incomeSources.name }).from(incomeSources).where(eq(incomeSources.taxTreatment, "w2")),
  ]);
  const holders = new Set(held.map((h) => h.accountId));
  const meta = acctRows.filter((a) => (INVESTMENT_TYPES as readonly string[]).includes(a.type) || holders.has(a.id));
  if (filter.accountId != null && !meta.some((a) => a.id === filter.accountId)) {
    throw new Error(`account ${filter.accountId} is not an investment account — investment accounts: ${meta.map((a) => `${a.id} ${a.name}`).join(", ") || "none"}`);
  }
  const ids = meta.map((a) => a.id);
  if (!ids.length) return applyFilter([], [], [], filter);
  const rows = await db
    .select({ id: transactions.id, accountId: transactions.accountId, postedAt: transactions.postedAt, amountCents: transactions.amountCents, text: transactions.merchantRaw, categoryKind: categories.kind, isTransfer: transactions.isTransfer, transferPairTxnId: transactions.transferPairTxnId })
    .from(transactions).leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(inArray(transactions.accountId, ids), eq(transactions.isExcluded, false), eq(transactions.isPending, false)));
  const amounts = [...new Set(rows.flatMap((r) => [r.amountCents, -r.amountCents]))];
  const pairIds = rows.flatMap((r) => (r.transferPairTxnId != null ? [r.transferPairTxnId] : []));
  const counterRows = amounts.length
    ? await db.select({ id: transactions.id, accountId: transactions.accountId, account: accounts.name, postedAt: transactions.postedAt, amountCents: transactions.amountCents, text: transactions.merchantRaw, isTransfer: transactions.isTransfer })
      .from(transactions).innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(eq(transactions.isExcluded, false), eq(transactions.isPending, false), ne(transactions.amountCents, 0), or(inArray(transactions.amountCents, amounts), pairIds.length ? inArray(transactions.id, pairIds) : undefined)))
    : [];
  const ledger: LedgerRow[] = rows.map((r) => ({ id: r.id, accountId: r.accountId, date: isoDate(r.postedAt), amountCents: r.amountCents, text: r.text, categoryKind: r.categoryKind, isTransfer: r.isTransfer, transferPairTxnId: r.transferPairTxnId }));
  const counter: CounterRow[] = counterRows.map((c) => ({ id: c.id, accountId: c.accountId, account: c.account, date: isoDate(c.postedAt), amountCents: c.amountCents, text: c.text, isTransfer: c.isTransfer }));
  const events = buildEvents(ledger, new Map(meta.map((a) => [a.id, a])), held, counter, sources.map((s) => s.name));
  return applyFilter(events, held, meta, filter);
}
