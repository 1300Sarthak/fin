import { isValid, parseISO } from "date-fns";

/**
 * The one transaction filter every page drills into. The URL is the state:
 * `/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&category=NAME&merchant=TEXT
 * &account=ID&kind=income|expense|cashflow|transfer&source=NAME&q=TEXT`, and the
 * CLI's `fin txns` reads the same fields, so a link and a command answer alike.
 * `cashflow` is the rows behind Made or Spent, so its net is the Spending page's Net.
 */
export const TXN_KINDS = ["income", "expense", "cashflow", "transfer"] as const;
export type TxnKind = (typeof TXN_KINDS)[number];
export type TxnFilter = {
  /** Inclusive local days, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Category name, case-insensitive; a parent includes its children. "Uncategorized" or "none" = no category. */
  category?: string;
  /** Substring of the description, case-insensitive. */
  merchant?: string;
  account?: number;
  kind?: TxnKind;
  /** Income source name: its match pattern plus the deposits its entries link to. */
  source?: string;
  /** Free text over description, bank memo and note. */
  q?: string;
  /** One ledger row by id, for links from records that point at a transaction. */
  id?: number;
};
export const TXN_FILTER_KEYS = ["from", "to", "category", "merchant", "account", "kind", "source", "q", "id"] as const;

type Params = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
export const validDay = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && isValid(parseISO(v)) ? v : undefined);

/** Reads the filter from URL params; anything malformed is dropped rather than guessed at. */
export function parseTxnFilter(params: Params): TxnFilter {
  const account = Number(one(params.account));
  const kind = one(params.kind);
  const id = Number(one(params.id));
  return {
    from: validDay(one(params.from)),
    to: validDay(one(params.to)),
    category: one(params.category)?.slice(0, 80),
    merchant: one(params.merchant)?.slice(0, 80),
    account: Number.isInteger(account) && account > 0 ? account : undefined,
    kind: TXN_KINDS.find((k) => k === kind),
    source: one(params.source)?.slice(0, 80),
    q: one(params.q)?.slice(0, 120),
    id: Number.isInteger(id) && id > 0 ? id : undefined,
  };
}

/** `?from=…&to=…` for a filter, dropping empty fields. */
export function txnHref(filter: TxnFilter): string {
  const qs = new URLSearchParams();
  for (const k of TXN_FILTER_KEYS) if (filter[k] != null && filter[k] !== "") qs.set(k, String(filter[k]));
  const s = qs.toString();
  return s ? `/transactions?${s}` : "/transactions";
}
