/**
 * Drill-down links into /transactions, per the shared contract:
 * from, to (inclusive YYYY-MM-DD), and optional category, merchant, account,
 * kind, q. Every number on the spending pages leads through here.
 */
export type TxnLink = {
  from?: string | null;
  to?: string | null;
  category?: string;
  merchant?: string;
  account?: number | string;
  kind?: "income" | "expense" | "cashflow" | "transfer";
  q?: string;
};

export function txnHref(link: TxnLink): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(link)) if (v != null && v !== "") p.set(k, String(v));
  const qs = p.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}
