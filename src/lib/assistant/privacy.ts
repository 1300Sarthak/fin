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

export class Privacy {
  private reals = new Map<string, string>(); // token -> real value
  private keys = new Map<string, string>(); // kind + lower(real) -> token
  private counter = { person: 0, ref: 0 };
  private nameLits: Literal[] = []; // case-insensitive, multi-word names
  private wordLits: Literal[] = []; // case-sensitive single words (first/last names)
  private maskLits: Literal[] = []; // account masks; string values only, never raw JSON
  private compiled: { names: RegExp | null; words: RegExp | null; masks: RegExp | null } | null = null;
  private accountTypes = new Map<string, string>();
  private businesses: Set<string>;
  rowsAggregated = 0;

  constructor(d: Dictionary) {
    this.businesses = new Set(d.businesses.map((b) => b.toLowerCase().trim()).filter(Boolean));
    for (const a of d.accounts) this.addAccount(a);
    const nonPersonWords = new Set<string>();
    const people: string[] = [];
    for (const m of d.merchants) {
      const hit = detectPerson(m.raw, { businesses: this.businesses, transfer: m.kind === "transfer" });
      if (hit) people.push(hit.name);
      else for (const w of m.raw.toLowerCase().split(/[^a-z']+/)) nonPersonWords.add(w);
    }
    for (const n of [...(d.names ?? []), ...people]) this.person(n);
    // Single first/last names, for notes like "Priya's birthday gift". Skipped when the word also names a business.
    for (const n of [...(d.names ?? []), ...people]) {
      for (const w of n.split(/\s+/)) {
        if (w.length < 3 || !/^[A-Z][a-z'’-]+$/.test(w) || NOT_A_NAME.has(w.toLowerCase()) || nonPersonWords.has(w.toLowerCase()) || this.businesses.has(w.toLowerCase())) continue;
        if (!this.keys.has(`person:${w.toLowerCase()}`) && !this.wordLits.some((l) => l.text === w)) this.wordLits.push({ text: w, token: this.person(n) });
      }
    }
  }

  private addAccount(a: { id: number; name: string; type: string }) {
    const token = tokenOf("acct", a.id);
    if (this.reals.has(token)) return;
    this.reals.set(token, a.name);
    this.accountTypes.set(token, a.type);
    this.keys.set(`acct:${a.name.toLowerCase()}`, token);
    // "Cash" or "Checking" alone names nothing; matching it would eat ordinary words.
    if (!a.name.split(/[^A-Za-z0-9]+/).filter(Boolean).every((w) => ACCOUNT_VOCAB.has(w.toLowerCase()))) this.addLiteral(this.nameLits, a.name, token);
    for (const m of a.name.matchAll(/\(([0-9a-z]{4})\)|\*+\s?(\d{4})|-\s?(\d{4})\b|\b(?:x|ending in\s?)(\d{4})\b/gi)) {
      const mask = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!/^(19|20)\d\d$/.test(mask)) this.addLiteral(this.maskLits, mask, token);
    }
    const base = a.name.replace(/[\s(]*[x*•.…#-]+\s?[0-9a-z]{4}\)?|\s?\([0-9a-z]{4}\)/gi, "").trim();
    const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (base !== a.name && words.some((w) => !ACCOUNT_VOCAB.has(w.toLowerCase().replace(/^\d+/, "")) && !this.businesses.has(w.toLowerCase()))) this.addLiteral(this.nameLits, base, token);
    // "Tamsin (2468)", "7Tamsin": a bare one-word account name is the owner's name.
    const owner = words.length === 1 ? words[0].replace(/^\d+/, "") : "";
    if (/^[A-Z][a-z]{2,}$/.test(owner) && !ACCOUNT_VOCAB.has(owner.toLowerCase()) && !this.businesses.has(owner.toLowerCase())) this.person(owner);
  }

  private addLiteral(list: Literal[], text: string, token: string) {
    const t = text.trim();
    if (t.length < 3 || list.some((l) => l.text.toLowerCase() === t.toLowerCase())) return;
    list.push({ text: t, token });
    this.compiled = null;
  }

  private regexes() {
    if (this.compiled) return this.compiled;
    const build = (list: Literal[], flags: string) => list.length
      ? new RegExp(`(?<![A-Za-z0-9])(?:${[...list].sort((a, b) => b.text.length - a.text.length).map((l) => escapeRe(l.text)).join("|")})(?![A-Za-z0-9])`, flags)
      : null;
    this.compiled = { names: build(this.nameLits, "gi"), words: build(this.wordLits, "g"), masks: build(this.maskLits, "gi") };
    return this.compiled;
  }

  private token(kind: "person" | "ref", real: string): string {
    const key = `${kind}:${real.toLowerCase()}`;
    const have = this.keys.get(key);
    if (have) return have;
    const token = tokenOf(kind, ++this.counter[kind]);
    this.keys.set(key, token);
    this.reals.set(token, real);
    return token;
  }

  person(name: string): string {
    const t = this.token("person", name.trim());
    this.addLiteral(name.includes(" ") ? this.nameLits : this.wordLits, name, t);
    return t;
  }
  ref(value: string): string { return this.token("ref", value); }

  /** ⟦acct:<id>⟧ for a known account id, registering the name if new. */
  account(id: number, name?: string, type?: string): string {
    const token = tokenOf("acct", id);
    if (!this.reals.has(token) && name) this.addAccount({ id, name, type: type ?? "" });
    return token;
  }
  accountType(token: string): string | undefined { return this.accountTypes.get(token); }
  accountByName(name: string): string {
    return this.keys.get(`acct:${name.toLowerCase()}`) ?? this.scrubText(name);
  }

  /** Known names only. Safe on serialised JSON: never touches digits outside a name. */
  scrubLiterals(s: string): string {
    const { names, words } = this.regexes();
    let out = s;
    if (names) out = out.replace(names, (m) => this.lookupLiteral(this.nameLits, m, true) ?? m);
    if (words) out = out.replace(words, (m) => this.lookupLiteral(this.wordLits, m, false) ?? m);
    return out.replace(/\/(Users|home)\/[^/\s"']+/g, (_m, root) => `/${root}/${this.ref("home-dir")}`);
  }

  private lookupLiteral(list: Literal[], m: string, ci: boolean) {
    return list.find((l) => (ci ? l.text.toLowerCase() === m.toLowerCase() : l.text === m))?.token;
  }

  /** Free text (a string value, a note, a summary): names, masks, emails, phones, codes. */
  scrubText(s: string): string {
    let out = this.scrubLiterals(s);
    const { masks } = this.regexes();
    if (masks) out = out.replace(masks, (m) => this.lookupLiteral(this.maskLits, m, true) ?? m);
    out = out
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => this.ref(m))
      .replace(/(?<![\d$.,])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, (m) => this.ref(m))
      .replace(/\b(conf(?:irmation)?|confirmation code|ref(?:erence)?|member(?:ship)?(?: number)?|record locator|pnr|check)\b\s*(?:#|no\.?|number|code)?\s*[:#]?\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{3,})\b/gi, (_m, label, code) => `${label} ${this.ref(code)}`)
      .replace(/(\*{2,}|\bx{1,2}|•+|\.{3}|…|\bending in\s?|\blast ?4:?\s?)(\d{4})(?!\d)/gi, (_m, _p, d) => this.ref(d))
      .replace(/\((?!(?:19|20)\d\d\))(\d{4})\)/g, (_m, d) => `(${this.ref(d)})`)
      .replace(/(?<![\d$.,])\d{9,}(?![\d.,])/g, (m) => this.ref(m));
    // Names after a payment channel that the dictionary did not know.
    return out.replace(/\b(zelle|venmo|cash ?app|paypal)((?:\s+(?:transfer|payment))?\s+(?:to|from)\s+)([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3})/gi, (m, ch, mid, name) => {
      const n = nameish(name, this.businesses, 1, false);
      return n ? `${ch}${mid}${this.person(n)}${name.slice(n.length)}` : m;
    });
  }

  /** A merchant for the model: a person-free brand, or "Zelle from ⟦person:N⟧". */
  merchant(raw: string, categoryKind?: string | null): string {
    const s = clean(raw);
    const hit = detectPerson(s, { businesses: this.businesses, transfer: categoryKind === "transfer" });
    if (!hit) return this.scrubText(brand(s));
    const t = this.person(hit.name);
    if (hit.freeText) return this.scrubText(s.replace(new RegExp(`\\b${escapeRe(hit.name)}\\b`, "g"), t));
    const via = hit.channel ? hit.channel[0].toUpperCase() + hit.channel.slice(1).toLowerCase() : "Transfer";
    return `${via}${hit.direction ? ` ${hit.direction}` : ""} ${t}`;
  }

  /* ---------------------------- structured output --------------------------- */

  private rowLimit = ROW_LIMIT;

  /** `minimize`, with a smaller row sample each time until the JSON fits in `cap` characters. */
  minimizeToFit(v: unknown, cap: number): string {
    const before = this.rowsAggregated;
    let out = "";
    for (const limit of [ROW_LIMIT, 10, 5, 0]) {
      this.rowsAggregated = before;
      this.rowLimit = limit;
      out = JSON.stringify(this.minimize(v));
      if (out.length <= cap) break;
    }
    this.rowLimit = ROW_LIMIT;
    return out;
  }

  /** Any JSON value from a read command, minimised for the model. Rows go through `row`. */
  minimize(v: unknown): unknown {
    if (typeof v === "string") return this.scrubText(v);
    if (Array.isArray(v)) {
      if (v.length && v.filter(isRow).length * 2 >= v.length) return this.rows(v);
      return v.map((x) => this.minimize(x));
    }
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEY.test(k)) continue;
      const key = this.scrubLiterals(k);
      if (typeof x === "string") out[key] = MERCHANT_KEY.test(k) ? this.merchant(x) : ACCOUNT_KEY.test(k) ? this.accountByName(x) : this.scrubText(x);
      else out[key] = this.minimize(x);
    }
    return out;
  }

  private rows(list: unknown[]) {
    const rows = list.map((r) => (isRow(r) ? this.row(r) : this.minimize(r)));
    if (rows.length <= this.rowLimit) return rows;
    this.rowsAggregated += rows.length - this.rowLimit;
    return { rows: rows.slice(0, this.rowLimit), omittedRows: rows.length - this.rowLimit, summary: summarize(rows as Record<string, unknown>[]) };
  }

  /** One row: ids, numbers, booleans, dates, merchant, account token, enum strings. Everything else is dropped. */
  row(o: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const desc = DESC_KEYS.find((k) => typeof o[k] === "string");
    const cat = isObj(o.category) ? o.category : null;
    const kind = typeof o.categoryKind === "string" ? o.categoryKind : typeof cat?.kind === "string" ? cat.kind : o.isTransfer === true ? "transfer" : null;
    for (const [k, v] of Object.entries(o)) {
      if (DROP_KEY.test(k)) continue;
      if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
      else if (typeof v === "string") {
        if (k === desc) out.merchant = this.merchant(v, kind);
        else if (DATE_KEYS.has(k) || /(At|On|Date)$/.test(k)) out[k] = /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : null;
        else if (ACCOUNT_KEY.test(k)) out[k] = this.accountByName(v);
        else if (ROW_STRINGS.has(k)) out[k] = this.scrubText(clean(v, 60));
      } else if (k === "account" && isObj(v)) out.account = typeof v.id === "number" ? this.account(v.id, String(v.name ?? ""), String(v.type ?? "")) : this.accountByName(String(v.name ?? ""));
      else if (k === "category" && isObj(v)) out.category = typeof v.name === "string" ? clean(v.name, 60) : null;
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v.map((x) => this.scrubText(clean(x as string, 40)));
      else if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v;
      else if (isRow(v)) out[k] = this.row(v);
      else if (Array.isArray(v)) out[k] = this.minimize(v);
    }
    return out;
  }

  /* ------------------------------- outbound -------------------------------- */

  /** The conversation as the provider sees it. User turns are the user's own words and go as typed. */
  outbound(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => m.role === "user" ? m
      : m.role === "tool" ? { ...m, content: this.scrubLiterals(m.content) }
        : { ...m, content: this.scrubText(m.content), ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ ...c, input: this.scrubDeep(c.input) })) } : {}) });
  }

  scrubDeep(v: unknown): unknown {
    if (typeof v === "string") return this.scrubText(v);
    if (Array.isArray(v)) return v.map((x) => this.scrubDeep(x));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.scrubDeep(x)]));
    return v;
  }

  rehydrate(s: string): string {
    return s.replace(TOKEN_RE, (m, kind, n) => this.reals.get(tokenOf(kind as TokenKind, n)) ?? m);
  }

  rehydrateDeep<T>(v: T): T {
    if (typeof v === "string") return this.rehydrate(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.rehydrateDeep(x)) as T;
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.rehydrateDeep(x)])) as T;
    return v;
  }

  /** Distinct tokens of each kind in what was actually sent. */
  redactions(sent: string[]): Redactions {
    const seen = { acct: new Set<string>(), person: new Set<string>(), ref: new Set<string>() };
    for (const s of sent) for (const m of s.matchAll(TOKEN_RE)) seen[m[1] as TokenKind].add(m[2]);
    return { accounts: seen.acct.size, people: seen.person.size, refs: seen.ref.size, rowsAggregated: this.rowsAggregated };
  }

  /** One line per active account token, for the system prompt. */
  legend(ids: number[]): string {
    return ids.map((id) => tokenOf("acct", id)).filter((t) => this.reals.has(t)).map((t) => `${t} ${this.accountTypes.get(t) || "account"}`).join(", ");
  }
}

function summarize(rows: Record<string, unknown>[]) {
  const amountKey = AMOUNT_KEYS.find((k) => rows.some((r) => typeof r[k] === "number"));
  const amount = (r: Record<string, unknown>) => (amountKey && typeof r[amountKey] === "number" ? (r[amountKey] as number) : 0);
  const group = (key: (r: Record<string, unknown>) => string) => {
    const m = new Map<string, { count: number; total: number }>();
    for (const r of rows) { const k = key(r); const g = m.get(k) ?? { count: 0, total: 0 }; g.count++; g.total += amount(r); m.set(k, g); }
    return [...m].sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total)).slice(0, 12).map(([name, g]) => ({ name, count: g.count, total: Math.round(g.total * 100) / 100 }));
  };
  return {
    count: rows.length, amountField: amountKey ?? null, total: Math.round(rows.reduce((a, r) => a + amount(r), 0) * 100) / 100,
    byCategory: group((r) => String(r.category ?? r.categoryName ?? r.kind ?? "Uncategorized")),
    byMerchant: group((r) => String(r.merchant ?? "Unknown")),
  };
}

/* ---------------------------------- loading --------------------------------- */

/** A fresh map from the live database: accounts, institutions, income sources and every distinct descriptor. */
export async function loadPrivacy(): Promise<Privacy> {
  const [accts, insts, sources, merchants] = await Promise.all([
    db.select({ id: accounts.id, name: accounts.name, type: accounts.type }).from(accounts),
    db.select({ name: institutions.name }).from(institutions),
    db.select({ name: incomeSources.name }).from(incomeSources),
    db.select({ raw: transactions.merchantRaw, kind: categories.kind, first: sql<number>`min(${transactions.id})` })
      .from(transactions).leftJoin(categories, eq(transactions.categoryId, categories.id))
      .groupBy(transactions.merchantRaw, categories.kind).orderBy(asc(sql`min(${transactions.id})`)),
  ]);
  const names = (process.env.FIN_PRIVATE_NAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Privacy({
    accounts: accts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    businesses: [...insts.map((i) => i.name), ...insts.flatMap((i) => i.name.split(/\s+/).slice(0, 1)), ...sources.map((s) => s.name)],
    merchants: merchants.map((m) => ({ raw: m.raw, kind: m.kind ?? null })),
    names,
  });
}

/** Byte-length-ish size and a head+tail cut of one outbound request, for the "what was sent" view. */
export function previewOf(payload: unknown, cap = 20_000): { chars: number; preview: string } {
  const text = JSON.stringify(payload, null, 1);
  if (text.length <= cap) return { chars: text.length, preview: text };
  const head = Math.floor(cap * 0.4);
  return { chars: text.length, preview: `${text.slice(0, head)}\n… ${text.length - cap} characters omitted …\n${text.slice(text.length - (cap - head))}` };
}

/**
 * Wrap a provider call so every request goes out pseudonymised and the answer
 * comes back rehydrated. For loops that are not runAssistant, e.g. `fin research`:
 *   researchLoop(request, { complete: privateComplete(complete, await loadPrivacy()), ... })
 * Tool-call inputs are left as the model wrote them: research tools only take tickers.
 */
export function privateComplete<O extends { system?: string; messages: ChatMessage[] }, R extends { text: string }>(
  complete: (o: O) => Promise<R>, priv: Privacy,
): (o: O) => Promise<R> {
  return async (o) => {
    const r = await complete({ ...o, system: o.system === undefined ? undefined : priv.scrubText(o.system), messages: priv.outbound(o.messages) });
    return { ...r, text: priv.rehydrate(r.text) };
  };
}
