import { inferAccountType, isLiability } from "@/lib/accounts";
import { normalizePayee } from "@/lib/normalize";
import { toCents } from "@/lib/format";
import type { NormalizedAccount, NormalizedHolding, NormalizedTransaction } from "./adapter";

/** Public SimpleFIN Bridge demo dataset (read-only). The demo *setup token* is
 *  single-claim and already used, but this access URL is shared and reusable. */
export const SIMPLEFIN_DEMO_ACCESS_URL =
  "https://demo:demo@beta-bridge.simplefin.org/simplefin";

/* ----------------------- raw SimpleFIN response shapes ------------------------ */
/* Defensive: field availability varies between protocol v1 and v2. */

type SFTransaction = {
  id: string;
  posted: number;
  transacted_at?: number;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
};

type SFOrg = {
  id?: string;
  name?: string;
  domain?: string;
  url?: string;
  "sfin-url"?: string;
};

type SFAccount = {
  id: string;
  name: string;
  currency: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  org?: SFOrg;
  conn_id?: string;
  transactions?: SFTransaction[];
  holdings?: {
    id: string;
    created?: number;
    symbol?: string;
    description?: string;
    shares?: string;
    market_value?: string;
    purchase_price?: string;
    cost_basis?: string;
    currency?: string;
  }[];
};

type SFResponse = {
  errors?: string[];
  errlist?: { code: string; msg: string }[];
  accounts?: SFAccount[];
  connections?: { conn_id: string; name?: string; org_id?: string }[];
};

/* --------------------------------- helpers ----------------------------------- */

const parseCents = (s?: string): number => toCents(Number.parseFloat(s ?? "0") || 0);

/** True for a SimpleFIN data access URL (vs. a setup token or a /claim/ URL). */
export function isAccessUrl(v: string): boolean {
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    return !new URL(v).pathname.includes("/claim/");
  } catch {
    return false;
  }
}

/**
 * Exchange a setup token for a credentials-bearing access URL. Accepts either a
 * base64 setup token or an already-decoded /claim/ URL. Setup tokens are
 * single-use — a second claim returns 403.
 */
export async function claimSetupToken(tokenOrClaimUrl: string): Promise<string> {
  const v = tokenOrClaimUrl.trim();
  const claimUrl = /^https?:\/\//i.test(v)
    ? v
    : Buffer.from(v, "base64").toString("utf8");
  if (!/^https?:\/\//.test(claimUrl)) {
    throw new Error("Invalid setup token (it did not decode to a URL).");
  }
  const res = await fetch(claimUrl, {
    method: "POST",
    headers: { "Content-Length": "0" },
  });
  if (res.status === 403) {
    throw new Error(
      "This SimpleFIN setup token was already claimed (tokens are single-use).",
    );
  }
  if (!res.ok) {
    throw new Error(`Claim failed: ${res.status} ${res.statusText}`);
  }
  const accessUrl = (await res.text()).trim();
  if (!isAccessUrl(accessUrl)) {
    throw new Error("Claim did not return a valid access URL.");
  }
  return accessUrl;
}

/** Fetch /accounts. Basic-auth creds are embedded in the access URL. */
export async function fetchSimplefin(
  accessUrl: string,
  opts: { startDate?: number; endDate?: number; pending?: boolean } = {},
): Promise<SFResponse> {
  const u = new URL(accessUrl);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";

  const url = new URL(`${u.toString().replace(/\/$/, "")}/accounts`);
  if (opts.startDate) url.searchParams.set("start-date", String(opts.startDate));
  if (opts.endDate) url.searchParams.set("end-date", String(opts.endDate));
  if (opts.pending) url.searchParams.set("pending", "1");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (username) {
    headers.Authorization =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    throw new Error(`SimpleFIN request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SFResponse;
}

/** Map a raw SimpleFIN response into the normalized ingest shape. */
export function simplefinToNormalized(resp: SFResponse): {
  accounts: NormalizedAccount[];
  errors: string[];
} {
  const errors = [
    ...(resp.errors ?? []),
    ...(resp.errlist ?? []).map((e) => `${e.code}: ${e.msg}`),
  ];
  const connById = new Map(
    (resp.connections ?? []).map((c) => [c.conn_id, c]),
  );

  const accounts: NormalizedAccount[] = (resp.accounts ?? []).map((a) => {
    const conn = a.conn_id ? connById.get(a.conn_id) : undefined;
    const orgName = a.org?.name ?? conn?.name ?? "Unknown";
    const orgId =
      a.org?.id ?? a.org?.domain ?? a.conn_id ?? conn?.org_id ?? null;
    const hasHoldings = (a.holdings?.length ?? 0) > 0;
    const type = inferAccountType(a.name, orgName, hasHoldings);

    const rawBalance = parseCents(a.balance);
    const balanceCents = isLiability(type) ? Math.abs(rawBalance) : rawBalance;

    const txns: NormalizedTransaction[] = (a.transactions ?? []).map((t) => {
      const merchantRaw =
        (t.payee || t.description || "").trim() || "(no description)";
      const ts = t.posted && t.posted > 0 ? t.posted : t.transacted_at ?? 0;
      return {
        externalId: t.id,
        postedAt: new Date(ts * 1000),
        amountCents: parseCents(t.amount),
        merchantRaw,
        payeeNormalized: normalizePayee(merchantRaw),
        memo: t.memo ?? null,
        isPending: Boolean(t.pending),
      };
    });

    // `purchase_price` is per-share, not a total: a provider reports a $100.00
    // price against 10 shares and a $1,000.00 basis. Keep it per-share so the
    // gain calculation does not silently divide by the wrong thing.
    const holdings: NormalizedHolding[] = (a.holdings ?? []).map((h) => ({
      externalId: h.id,
      symbol: h.symbol?.trim() || null,
      description: h.description?.trim() || null,
      shares: Number.parseFloat(h.shares ?? "0") || 0,
      marketValueCents: parseCents(h.market_value),
      costPerShareCents: h.purchase_price ? parseCents(h.purchase_price) : null,
      currency: /^[A-Za-z]{3}$/.test(h.currency ?? "")
        ? (h.currency as string).toUpperCase()
        : "USD",
      // `created` is when the provider minted the row, not when it was priced;
      // at some brokerages it is months stale. `balance-date` is the price date.
      asOf: new Date((a["balance-date"] || h.created || 0) * 1000),
    }));

    const currency = /^[A-Za-z]{3}$/.test(a.currency)
      ? a.currency.toUpperCase()
      : "USD";

    return {
      externalId: a.id,
      name: a.name,
      type,
      currency,
      balanceCents,
      availableBalanceCents:
        a["available-balance"] != null
          ? parseCents(a["available-balance"])
          : null,
      balanceDate: new Date((a["balance-date"] || 0) * 1000),
      institution: {
        externalId: orgId,
        name: orgName,
        domain: a.org?.domain ?? null,
      },
      transactions: txns,
      holdings,
    };
  });

  return { accounts, errors };
}
