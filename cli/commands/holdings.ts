/**
 * `fin holdings` — what the investment accounts actually hold.
 *
 * Exists because the balance alone hides the thing that matters most: an
 * account can be fully funded and still sit in a settlement fund, earning
 * nothing. The cash line is printed first for that reason.
 */
import { num, RANGE, str, type Args } from "../args";
import { emit, heading, kv, money, pct, table } from "../render";
import { getHoldings, getPortfolioSummary, isCashLike } from "@/lib/holdings";

const signedPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

export async function holdings(a: Args, json: boolean) {
  const accountId = num(a, "account", RANGE.id);
  const symbol = str(a, "symbol")?.toUpperCase();
  const [rows, sum] = await Promise.all([
    getHoldings(accountId),
    getPortfolioSummary(accountId),
  ]);
  const shown = symbol ? rows.filter((r) => r.symbol?.toUpperCase() === symbol) : rows;

  // `summary` is never narrowed by --symbol, so a JSON reader that saw only
  // `{summary, holdings: []}` had no way to tell "holds nothing" from "holds
  // none of ZZZ". Say which filter ran, what it matched, and what the summary
  // actually covers.
  const payload = {
    filter: { account: accountId ?? null, symbol: symbol ?? null },
    matched: shown.length,
    summaryScope: symbol
      ? `whole portfolio${accountId == null ? "" : ` for account ${accountId}`} — the --symbol filter is not applied to the summary`
      : accountId == null
        ? "all accounts"
        : `account ${accountId}`,
    symbolsHeld: [...new Set(rows.map((r) => r.symbol).filter((s): s is string => !!s))],
    summary: sum,
    holdings: shown,
  };

  emit(json, payload, () => {
    if (!rows.length) {
      return accountId == null
        ? "No holdings recorded. Run `fin sync` — positions arrive with the account data."
        : `No holdings recorded for --account ${accountId}. Run fin accounts for the ids that exist.`;
    }
    if (!shown.length) {
      return `No holding matches --symbol ${symbol}. Held: ${[...new Set(rows.map((r) => r.symbol ?? "—"))].join(", ")}.`;
    }
    const out = [
      kv([
        [symbol ? "Total (whole portfolio)" : "Total", money(sum.totalCents)],
        ["Invested", money(sum.investedCents)],
        ["Cash / money market", `${money(sum.cashCents)}  (${pct(sum.cashPct)})`],
        ["Positions", String(sum.positions)],
        ["Priced", sum.asOf ? sum.asOf.toISOString().slice(0, 10) : "—"],
      ]),
    ];
    if (sum.cashPct >= 20) {
      out.push(`\n${money(sum.cashCents)} (${pct(sum.cashPct)}) is sitting in cash, not invested.`);
    }
    if (sum.topConcentrationPct >= 20 && sum.topSymbol) {
      out.push(`${sum.topSymbol} alone is ${pct(sum.topConcentrationPct)} of the total.`);
    }

    const byAccount = new Map<string, typeof shown>();
    for (const r of shown) {
      const list = byAccount.get(r.accountName) ?? [];
      list.push(r);
      byAccount.set(r.accountName, list);
    }
    const ordered = [...byAccount.entries()].sort(
      (a, b) =>
        b[1].reduce((s, r) => s + r.marketValueCents, 0) -
        a[1].reduce((s, r) => s + r.marketValueCents, 0),
    );
    for (const [name, acctRows] of ordered) {
      out.push(
        "\n" + heading(name),
        table(
          [
            { head: "SYMBOL" },
            { head: "NAME" },
            { head: "VALUE", align: "r" },
            { head: "%", align: "r" },
            { head: "SHARES", align: "r" },
            { head: "COST/SH", align: "r" },
            { head: "GAIN", align: "r" },
          ],
          acctRows.map((x) => [
            isCashLike(x.symbol, x.description) ? `${x.symbol ?? "CASH"} *` : x.symbol ?? "—",
            (x.description ?? "").slice(0, 28),
            money(x.marketValueCents),
            pct(x.pctOfAccount),
            x.shares.toFixed(4).replace(/\.?0+$/, ""),
            x.costPerShareCents ? money(x.costPerShareCents) : "—",
            signedPct(x.gainPct),
          ]),
        ),
      );
    }
    out.push("\n* held in cash / money market");
    return out.join("\n");
  });
}
