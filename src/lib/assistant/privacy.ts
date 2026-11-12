import "server-only";
/**
 * What the hosted model may see. Every byte the assistant sends to the provider
 * (system prompt, snapshot, tool results, its own earlier answers) goes through
 * one `Privacy` instance first; the user's own messages are sent as typed.
 *
 *   - Pseudonymise: account names and masks become ⟦acct:<id>⟧, people (Zelle and
 *     Venmo counterparties, names in notes, the owner's name) ⟦person:N⟧, and
 *     emails, phone numbers, confirmation and member codes ⟦ref:N⟧.
 *   - Minimise: row-level lists (anything with a date and an amount) keep only
 *     ids, dates, numbers, a normalised merchant and a few enum-like strings;
 *     long lists are cut to ROW_LIMIT rows plus category and merchant totals.
 *     Memos, notes and raw descriptors never leave.
 *   - Rehydrate: tokens in the model's answer and tool arguments are swapped
 *     back for the real values here, so proposals run against real rows.
 *
 * The token map lives in this object only: never stored, never sent.
 */
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, categories, incomeSources, institutions, transactions } from "@/db/schema";
import type { ChatMessage } from "@/lib/ai/types";
import { clean } from "./changes";

export type TokenKind = "acct" | "person" | "ref";
export type Redactions = { accounts: number; people: number; refs: number; rowsAggregated: number };
export type PrivacyReport = { provider: string; model: string; sentChars: number; redactions: Redactions; preview?: string };

export const ROW_LIMIT = 20;
const TOKEN_RE = /⟦\s*(acct|person|ref)\s*:\s*(\d+)\s*⟧/g;
const tokenOf = (kind: TokenKind, n: number | string) => `⟦${kind}:${n}⟧`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/* ------------------------------ person detector ----------------------------- */

/** Words that end a transfer phrase without naming a person. */
const NOT_A_NAME = new Set(("savings sav checking chk account acct card credit debit brokerage ira roth hsa apple pay cash venmo zelle paypal wallet " +
  "bank external internal investment individual joint loan mortgage the my your our self me myself online mobile wire ach deposit payment " +
  "transfer confirmation conf ref visa mastercard amex discover robinhood fidelity vanguard schwab chase sofi coinbase spending other intern").split(" "));
const BUSINESS_WORDS = /\b(inc|llc|ltd|corp|corporation|co|company|payroll|dir dep|direct dep(osit)?|bank|university|school|college|services?|store|market|restaurant|cafe|hotel|inn|airlines?|insurance|treasury|irs|tax|refund|interest|dividend|bonus|rewards?|cashback|promotion|referral|buy|sell|shop|pay|fee)\b/i;
/** Lower-case words that follow "with/for" in hand-typed rows without being a name. */
const COMMON = new Set(("the a an my me him her them us you friends friend family mom dad mum mumma papa food dinner lunch breakfast gas rent " +
  "cash card gift work school trip home everyone roommates team").split(" "));
const CHANNEL = /\b(zelle|venmo|cash ?app|paypal|apple cash)\b/i;

export type PersonHit = { name: string; channel: string; direction: string; freeText: boolean };

function nameish(candidate: string, businesses: Set<string>, minWords: number, capitalised: boolean): string | null {
  const s = candidate.replace(/\s+for\s+".*$/i, "").replace(/\s*;.*$/, "").replace(/\s*\bconf(?:irmation)?\b\s*#?.*$/i, "").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < minWords || words.length > 5) return null;
  if (!words.every((w) => (capitalised ? /^[A-Z][A-Za-z'’.-]*$/ : /^[A-Za-z][A-Za-z'’.-]*$/).test(w))) return null;
  if (NOT_A_NAME.has(words[0].toLowerCase()) || words.every((w) => NOT_A_NAME.has(w.toLowerCase()))) return null;
  if (BUSINESS_WORDS.test(s) || businesses.has(s.toLowerCase()) || businesses.has(words[0].toLowerCase())) return null;
  return s;
}

/**
 * Whether a bank descriptor names a person, and who. Business payees ("Uber",
 * "Safeway", "Acme payroll") return null.
 *   - "Zelle Transfer from Jane Doe for \"rent\"; Conf#", "Venmo to Sam": any channel + to/from + name
 *   - "Transfer Jane Doe", "Online Transfer to Jane Doe": two or more capitalised words
 *   - "Jane Doe" alone, only when the row is a transfer
 *   - "dinner with rochu": a lower-case name in a hand-typed row
 */
export function detectPerson(raw: string, opts: { businesses?: Set<string>; transfer?: boolean } = {}): PersonHit | null {
  const businesses = opts.businesses ?? new Set<string>();
  const s = raw.replace(/\s+/g, " ").trim();
  const channel = CHANNEL.exec(s);
  if (channel) {
    const m = /\b(to|from)\s+(.+)$/i.exec(s.slice(channel.index));
    const name = m && nameish(m[2], businesses, 1, false);
    if (name) return { name, channel: channel[1], direction: m![1].toLowerCase(), freeText: false };
  }
  const t = /^(?:(?:online|mobile|internal|external|instant)\s+)*(?:banking\s+)?transfer\s+(?:(to|from)\s+)?(.+)$/i.exec(s);
  if (t) {
    const name = nameish(t[2], businesses, 2, true);
    if (name) return { name, channel: "", direction: (t[1] ?? "").toLowerCase(), freeText: false };
  }
  if (opts.transfer && /^[A-Z][a-z'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z'’-]+){1,2}$/.test(s)) {
    const name = nameish(s, businesses, 2, true);
    if (name) return { name, channel: "", direction: "", freeText: false };
  }
  if (s === s.toLowerCase()) {
    const w = /\b(?:with|for|from|to)\s+([a-z]{3,})\b/.exec(s);
    if (w && !COMMON.has(w[1]) && !NOT_A_NAME.has(w[1])) return { name: w[1], channel: "", direction: "", freeText: true };
  }
  return null;
}

/** The merchant without the bank's routing noise: quoted memos, Conf# codes, "Apple Pay Ending in", "Mobile". */
export function brand(raw: string): string {
  const s = raw.replace(/\s+for\s+"[^"]*"?;?/gi, " ").replace(/\s*\bconf(?:irmation)?\s*#\s*[\w-]*/gi, " ")
    .replace(/\s*[A-Za-z]+apple pay\b.*$/i, "").replace(/\s+apple pay ending in.*$/i, "")
    .replace(/^mobile\s+/i, "").replace(/\s+(?:aa|cad|usd)$/i, "").replace(/\s+/g, " ").trim();
  return s || clean(raw);
}

/* -------------------------------- row shapes -------------------------------- */

const DATE_KEYS = new Set(["date", "postedAt", "paidOn", "pendingDate", "postedDate", "datePurchased", "startDate", "dueAt", "workDate"]);
const AMOUNT_KEYS = ["amountCents", "amount", "amount_usd", "costCents", "displayAmountCents", "rawAmountCents", "econCents"];
/** First present one names the row; the others are dropped from rows. */
const DESC_KEYS = ["merchant", "merchantRaw", "payee", "counterparty", "name", "item", "title", "description", "provider"];
/** Enum-like strings a row keeps (after scrubbing). Any other row string is dropped. */
const ROW_STRINGS = new Set(["kind", "status", "type", "cadence", "symbol", "bucket", "label", "currency", "taxTreatment", "category", "categoryName",
  "categoryKind", "activityKind", "activityLabel", "confidence", "severity", "accountType", "month", "workMonth", "monthKey", "security"]);
const DROP_KEY = /^(memo|notes?|externalId|simplefinOrgId|domain|matchPattern|memberLast4|member\w*|e?mails?|email\w*|phones?|phone\w*|address\w*|payeeNormalized|database|accessUrl|\w*[Tt]oken|secret\w*)$/;
const ACCOUNT_KEY = /^(account|accountName|sourceAccountName|pairedAccountName|paymentMethod|fundedBy|sentTo)$/;
const MERCHANT_KEY = /^(merchant|merchantRaw|payee|counterparty|description)$/;

export const isRow = (o: unknown): o is Record<string, unknown> =>
  isObj(o) && Object.keys(o).some((k) => DATE_KEYS.has(k)) && AMOUNT_KEYS.some((k) => typeof o[k] === "number");

/* --------------------------------- dictionary ------------------------------- */

export type Dictionary = {
  accounts: { id: number; name: string; type: string }[];
  /** Institutions, income sources and other known companies: never people. */
  businesses: string[];
  /** Distinct raw descriptors, oldest first, with their category kind. */
  merchants: { raw: string; kind: string | null }[];
  /** Extra private names (FIN_PRIVATE_NAMES, comma separated). */
  names?: string[];
};

const ACCOUNT_VOCAB = new Set(("checking savings total credit card advantage individual crypto spending roth ira plan inc usa health account cash " +
  "management brokerage other hsa 401k k the of and premier platinum gold rewards secured joint traditional sep trust").split(" "));

type Literal = { text: string; token: string };

