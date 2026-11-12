/**
 * The pure half of categorisation: everything decided without the database or
 * a provider, so it can be tested row by row. `categorize.ts` loads the rows
 * and writes the answers.
 *
 * Order of evidence, strongest first:
 *   1. the user's own rules (priority < 50)
 *   2. income sources (`income_sources.matchPattern`)
 *   3. structure: a row already flagged as a transfer, a card payment, a sweep
 *   4. precedent: how the user's history filed the same merchant brand
 *   5. built-in patterns for investment accounts and P2P apps
 *   6. the shipped system rules, then the merchant cache
 *   7. only then the AI, given the allowed list and the user's own examples
 */
import { z } from "zod";
import { detectPerson } from "@/lib/assistant/privacy";
import { normalizePayee } from "@/lib/normalize";

export type Cat = { id: number; name: string; kind: string; parentId: number | null };
export type Rule = { pattern: string; isRegex: boolean; categoryId: number; priority: number };
export type Source = "rule" | "history" | "builtin" | "cache" | "ai";
export type Choice = { categoryId: number; source: Source; confidence: number; reason: string };

/** One ledger row with the context the decision may use. `accountType`, never the account name. */
export type Row = {
  id: number;
  merchantRaw: string;
  payeeNormalized: string;
  memo: string | null;
  note: string | null;
  amountCents: number;
  postedAt: Date;
  accountType: string;
  isTransfer: boolean;
  isRecurring: boolean;
  /** Another own account has the opposite amount within four days. */
  counterpartType: string | null;
  /** The category of the pending hold this posted row replaces, when it had one. */
  pendingCategoryId?: number | null;
};

export type Precedent = { categoryId: number; share: number; weight: number };

const INVESTMENT_ACCOUNTS = new Set(["brokerage", "ira", "hsa", "crypto"]);
const LIABILITY_ACCOUNTS = new Set(["credit", "loan"]);
const CARD_PAYMENT = /\b(payment thank you|autopay|auto pay|e-?payment|epay|card ?payment|credit card(?: payment)?|cardmember|bill ?pay|pymt)\b/i;
const PAYMENT_WORD = /\b(payment|pymt|thank you)\b/i;
const SWEEP = /\b(money market|core (?:account|position)|sweep|spaxx|fdrxx|fzfxx|vmfxx|vmrxx|swvxx|redemption from|purchase into)\b/i;
const OWN_TRANSFER = /\b(?:transfer|xfer|from|to)\s+(?:my\s+)?(?:savings|checking|brokerage|sav|chk)\b|\bbrokerage deposit\b|\binternal transfer\b|\bround-?up\b/i;
const TRADE = /\b(?:buy|sell|bought|sold)\b.*\b(?:shares?|for each)\b|\binvestment (?:buy|sell)\b|\brealized ?gain ?loss\b|\breinvest/i;
const CONTRIBUTION = /\bcontribution\b/i;
const DIVIDEND = /\bdividend\b/i;
const TAX = /\b(?:foreign tax|tax withheld|tax paid)\b/i;
const PAYROLL = /\b(payroll|direct dep(?:osit)?|salary|paycheck)\b/i;
const P2P = /\b(zelle|venmo|cash ?app|paypal|apple cash)\b/i;
/** Card credits that are not a merchant giving money back. */
const CARD_CREDIT = /\b(cash ?back|rewards?|bonus|interest|statement credit|adjustment|redemption)\b/i;
const FEE = /\b(fees?|surcharges?|service charges?|bal inq)\b/i;
const BANK_ACCOUNTS = new Set(["checking", "savings", "hysa", "cash", "other"]);

/* --------------------------------- matching --------------------------------- */

/** A merchant key that survives the bank's routing noise: store numbers, "Apple Pay Ending in", quoted memos. */
export function brandKey(raw: string): string {
  const s = raw
    .replace(/\s+for\s+"[^"]*"?;?/gi, " ")
    .replace(/\s*\bconf(?:irmation)?\s*#\s*[\w-]*/gi, " ")
    .replace(/\s*[A-Za-z]*apple pay\b.*$/i, "")
    .replace(/^(?:mobile|sq|tst|pos)\s*\*?\s*/i, "");
  return normalizePayee(s);
}

/**
 * Whether a plain rule pattern occurs in `text` starting at a word boundary.
 * A bare substring let "ups" claim "cups" and "lime" claim "sublime"; the
 * trailing edge stays open because stored patterns are often truncated
 * ("brightpath learni").
 */
export function ruleHits(rule: Pick<Rule, "pattern" | "isRegex">, text: string): boolean {
  if (rule.isRegex) {
    try { return new RegExp(rule.pattern, "i").test(text); } catch { return false; }
  }
  const p = rule.pattern.toLowerCase().trim();
  if (!p) return false;
  const lead = /^\w/.test(p) ? "(?<![a-z0-9])" : "";
  return new RegExp(lead + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text);
}

/**
 * A merchant rule does not claim that merchant's fee rows: "mercantile" is
 * the ATM withdrawal, "Mercantile … Fee" is a bank charge. A rule whose own
 * pattern names the fee still matches. (A per-rule exact/contains mode would
 * say this directly; it needs a schema column.)
 */
export function firstRule(rules: Rule[], text: string): Rule | null {
  const fee = FEE.test(text);
  return rules.find((r) => ruleHits(r, text) && (!fee || r.isRegex || FEE.test(r.pattern))) ?? null;
}

/**
 * Money between a Robinhood brokerage and its own card, or a bank: the
 * descriptor is just "Robinhood" on every side, so only the account and the
 * sign tell them apart. Out of the brokerage is the card being paid; into the
 * brokerage, or out of a bank to it, is a deposit.
 */
export function ownBrokerTransfer(row: Pick<Row, "merchantRaw" | "accountType" | "amountCents">): "Credit Card Payment" | "Account Transfer" | null {
  if (brandKey(row.merchantRaw) !== "robinhood") return null;
  if (row.accountType === "brokerage") return row.amountCents < 0 ? "Credit Card Payment" : "Account Transfer";
  if (LIABILITY_ACCOUNTS.has(row.accountType)) return row.amountCents > 0 ? "Credit Card Payment" : null;
  if (BANK_ACCOUNTS.has(row.accountType)) return "Account Transfer";
  return null;
}

/* ------------------------------- precedent ---------------------------------- */

/** Only the user's own filing counts. AI and cache labels are excluded so an old wrong guess cannot vote for itself. */
const SOURCE_WEIGHT: Record<string, number> = { manual: 3, rule: 2 };
/** Words that start too many unrelated descriptors to stand alone as a brand. */
const GENERIC_HEAD = new Set(["the", "buy", "sell", "transfer", "zelle", "venmo", "paypal", "cashapp", "cash", "apple", "online", "mobile", "purchase", "investment", "from", "to", "payment", "deposit", "withdrawal", "atm", "check", "ach", "debit", "credit"]);

export type History = { key: string; categoryId: number; source: string };

/**
 * The user's own filing for each merchant brand. A key is decided when its
 * weighted vote is at least two thirds for one category; manual corrections
 * count three times as much as anything the app guessed.
 */
export function buildPrecedents(rows: History[]): Map<string, Precedent> {
  const votes = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (!r.key || !SOURCE_WEIGHT[r.source]) continue;
    const m = votes.get(r.key) ?? new Map<number, number>();
    m.set(r.categoryId, (m.get(r.categoryId) ?? 0) + SOURCE_WEIGHT[r.source]);
    votes.set(r.key, m);
  }
  const out = new Map<string, Precedent>();
  for (const [key, m] of votes) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [categoryId, w] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (w / total >= 2 / 3) out.set(key, { categoryId, share: w / total, weight: w });
  }
  return out;
}

/** Exact brand first, then the longest decided key that is a whole-word prefix ("corner pizza" for "corner pizza springfield"). */
export function findPrecedent(key: string, precedents: Map<string, Precedent>): Precedent | null {
  const exact = precedents.get(key);
  if (exact) return exact;
  const words = key.split(" ");
  for (let n = words.length - 1; n >= 1; n--) {
    const prefix = words.slice(0, n).join(" ");
    if (n === 1 && (GENERIC_HEAD.has(prefix) || prefix.length < 5)) break;
    if (GENERIC_HEAD.has(words[0]) && n < 3) break;
    const hit = precedents.get(prefix);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------ deterministic ------------------------------- */

export type Context = {
  byName: Map<string, Cat>;
  userRules: Rule[];
  systemRules: Rule[];
  incomeSources: { matchPattern: string | null; taxTreatment: string }[];
  precedents: Map<string, Precedent>;
  cache: Map<string, { categoryId: number; confidence: number | null }>;
};

const kindOf = (ctx: Context, id: number) => [...ctx.byName.values()].find((c) => c.id === id)?.kind;

/**
 * Everything that can be decided without a model, or null. A row already
 * flagged as a transfer only ever receives a transfer category: anything else
 * would silently flip it back into income or spending.
 */
export function decide(row: Row, ctx: Context): Choice | null {
  const text = `${row.merchantRaw} ${row.payeeNormalized} ${row.memo ?? ""}`.toLowerCase();
  const key = brandKey(row.merchantRaw);
  const cat = (name: string) => ctx.byName.get(name)?.id;
  const pick = (name: string, source: Source, confidence: number, reason: string): Choice | null => {
    const id = cat(name);
    return id == null ? null : { categoryId: id, source, confidence, reason };
  };
  // A transfer only gets a transfer category; money out never gets an income one.
  const fits = (p: Choice | null) => !!p &&
    (!row.isTransfer || kindOf(ctx, p.categoryId) === "transfer") &&
    !(row.amountCents < 0 && kindOf(ctx, p.categoryId) === "income");
  const investAcct = INVESTMENT_ACCOUNTS.has(row.accountType);
  const cardSide = LIABILITY_ACCOUNTS.has(row.accountType) || (row.counterpartType != null && LIABILITY_ACCOUNTS.has(row.counterpartType));

  // The same purchase, seen earlier as a pending hold.
  if (row.pendingCategoryId != null) {
    const p: Choice = { categoryId: row.pendingCategoryId, source: "history", confidence: 0.98, reason: "category of the pending hold" };
    if (fits(p)) return p;
  }

  // Account- and sign-aware: outranks any merchant-only rule.
  const broker = ownBrokerTransfer(row);
  if (broker) return pick(broker, "builtin", 0.97, "Robinhood: account and direction");

  // Money back onto a card from a shop is a refund, whatever the shop's rule says.
  if (LIABILITY_ACCOUNTS.has(row.accountType) && row.amountCents > 0 && !row.isTransfer && row.counterpartType == null && !OWN_TRANSFER.test(text) && !/\b(transfer|deposit)\b/i.test(text) && !PAYMENT_WORD.test(text) && !CARD_PAYMENT.test(text) && !P2P.test(text) && !CARD_CREDIT.test(text)) {
    const refund = pick("Refunds", "builtin", 0.9, "money back on a card");
    if (refund) return refund;
  }

  const user = firstRule(ctx.userRules, text);
  if (user) {
    const p: Choice = { categoryId: user.categoryId, source: "rule", confidence: 1, reason: `your rule "${user.pattern}"` };
    if (fits(p)) return p;
  }

  if (row.amountCents > 0) {
    const src = ctx.incomeSources.find((s) => s.matchPattern && ruleHits({ pattern: s.matchPattern, isRegex: false }, text));
    if (src && !row.isTransfer) return pick(src.taxTreatment === "w2" ? "Paycheck" : "Other Income", "builtin", 0.97, "income source");
  }

  // Structure: card payments and money that only moved between own accounts.
  if (row.isTransfer) {
    return pick(cardSide || CARD_PAYMENT.test(text) ? "Credit Card Payment" : "Account Transfer", "builtin", 0.95, "flagged transfer");
  }
  if (LIABILITY_ACCOUNTS.has(row.accountType) && row.amountCents > 0 && PAYMENT_WORD.test(text)) {
    return pick("Credit Card Payment", "builtin", 0.97, "payment on a card");
  }
  if (!LIABILITY_ACCOUNTS.has(row.accountType) && row.amountCents < 0 && CARD_PAYMENT.test(text) && !P2P.test(text)) {
    return pick("Credit Card Payment", "builtin", 0.93, "card payment out of a bank account");
  }
  if (investAcct && SWEEP.test(text)) return pick("Account Transfer", "builtin", 0.93, "cash sweep");
  if (OWN_TRANSFER.test(text) && !P2P.test(text)) return pick("Account Transfer", "builtin", 0.9, "own-account transfer");

  const prior = findPrecedent(key, ctx.precedents);
  if (prior) {
    const p: Choice = { categoryId: prior.categoryId, source: "history", confidence: Math.min(0.99, 0.6 + 0.4 * prior.share), reason: "your earlier filing of this merchant" };
    if (fits(p)) return p;
  }

  if (investAcct) {
    const invest = row.accountType === "ira" ? "Retirement" : row.accountType === "crypto" ? "Crypto" : "Brokerage";
    if (TAX.test(text)) return pick("Taxes", "builtin", 0.9, "tax withheld on investments");
    if (TRADE.test(text) || CONTRIBUTION.test(text) || DIVIDEND.test(text)) return pick(invest, "builtin", 0.9, "investment activity");
  }
  if (row.amountCents > 0 && PAYROLL.test(text)) return pick("Paycheck", "builtin", 0.9, "payroll");

  const sys = firstRule(ctx.systemRules, text);
  const sysPick: Choice | null = sys && { categoryId: sys.categoryId, source: "rule", confidence: 0.85, reason: `built-in rule "${sys.pattern}"` };
  if (fits(sysPick)) return sysPick;

  const cached = ctx.cache.get(row.payeeNormalized);
  if (cached) {
    const p: Choice = { categoryId: cached.categoryId, source: "cache", confidence: cached.confidence ?? 0.7, reason: "merchant cache" };
    if (fits(p)) return p;
  }
  return null;
}

