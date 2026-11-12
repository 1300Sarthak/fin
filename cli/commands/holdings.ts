/**
 * `fin holdings` — what the investment accounts actually hold.
 *
 * Exists because the balance alone hides the thing that matters most: an
 * account can be fully funded and still sit in a settlement fund, earning
 * nothing. The cash line is printed first for that reason.
 */
import { bool, num, pick, RANGE, str, type Args } from "../args";
import { clip, emit, heading, kv, money, pct, table } from "../render";
import { getHoldings, getInvestmentValueGap, getPortfolioSummary, investmentValueGapNote, isCashLike } from "@/lib/holdings";
import { getInvestmentHistory, HISTORY_KINDS } from "@/lib/investment-history";
import { rangeDay } from "@/lib/income";

const signedPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

export async function holdings(a: Args, json: boolean) {
  const accountId = num(a, "account", RANGE.id);
  const symbol = str(a, "symbol")?.toUpperCase();
  const [rows, sum, gap] = await Promise.all([
    getHoldings(accountId),
    getPortfolioSummary(accountId),
    getInvestmentValueGap(),
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
    valueGap: gap,
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
        [symbol ? "Positions (whole portfolio)" : "Positions total", money(sum.totalCents)],
        ["Invested", money(sum.investedCents)],
        ["Cash / money market", `${money(sum.cashCents)}  (${pct(sum.cashPct)})`],
        ["Position count", String(sum.positions)],
        ["Priced", sum.asOf ? sum.asOf.toISOString().slice(0, 10) : "—"],
      ]),
    ];
    // Ties this total to the Investments headline, which is account balances incl. cash.
    if (accountId == null) out.push(investmentValueGapNote(gap, money));
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
            { head: "GAIN $", align: "r" },
          ],
          acctRows.map((x) => [
            isCashLike(x.symbol, x.description) ? `${x.symbol ?? "CASH"} *` : x.symbol ?? "—",
            (x.description ?? "").slice(0, 28),
            money(x.marketValueCents),
            pct(x.pctOfAccount),
            x.shares.toFixed(4).replace(/\.?0+$/, ""),
            x.costPerShareCents ? money(x.costPerShareCents) : "—",
            signedPct(x.gainPct),
            x.gainCents == null ? "—" : money(x.gainCents),
          ]),
        ),
      );
    }
    out.push("\n* held in cash / money market");
    return out.join("\n");
  });
}

/**
 * `fin activity` — what was bought, sold, paid in and taken out of the
 * investment accounts, when, and with what money. Every inferred line says so;
 * what the feed cannot tell (shares, price, lots) prints as "?".
 */
export async function activity(a: Args, json: boolean) {
  if (a._.length) throw new Error(`fin activity takes no positional arguments, got "${a._.join(" ")}"`);
  const from = str(a, "from"), to = str(a, "to");
  const data = await getInvestmentHistory({
    accountId: num(a, "account", RANGE.id),
    symbol: str(a, "symbol"),
    kind: pick(a, "kind", HISTORY_KINDS),
    from: from ? rangeDay(from, "start") : undefined,
    to: to ? rangeDay(to, "end") : undefined,
    includeInternal: bool(a, "all"),
  });
  const limit = num(a, "limit", RANGE.limit);
  emit(json, data, () => {
    const out: string[] = [];
    const shown = limit ? data.events.slice(0, limit) : data.events;
    if (!shown.length) out.push("No investment activity matches.");
    else {
      out.push(heading(`activity, newest first (${data.events.length}${data.hiddenInternal ? `; ${data.hiddenInternal} sweep/duplicate rows hidden, --all shows them` : ""})`));
      out.push(table(
        [{ head: "DATE" }, { head: "ACCOUNT" }, { head: "KIND" }, { head: "SECURITY" }, { head: "AMOUNT", align: "r" }, { head: "HOW / WHERE" }, { head: "TXN", align: "r" }],
        shown.map((e) => [
          e.date, clip(e.account, 22), e.kind + (e.confidence === "inferred" ? "?" : "") + (e.internal ? " (internal)" : ""),
          clip(e.symbol ?? e.security ?? "?", 26), money(e.amountCents),
          clip((e.fundedBy ?? e.sentTo)?.label ?? "", 44), e.txnId,
        ]),
      ));
    }
    const syms = data.symbols.filter((s) => s.buys || s.sells);
    if (syms.length) {
      out.push(heading("by security (ledger buys/sells, valued at today's holdings)"));
      out.push(table(
        [{ head: "SECURITY" }, { head: "FIRST BUY" }, { head: "BUYS", align: "r" }, { head: "INVESTED", align: "r" }, { head: "SOLD", align: "r" }, { head: "SHARES", align: "r" }, { head: "VALUE", align: "r" }, { head: "LEDGER GAIN", align: "r" }],
        syms.map((s) => [
          clip(s.symbol ? `${s.symbol} ${s.security ?? ""}` : s.security ?? s.key, 30), s.firstBought ?? "?", s.buys, money(s.investedCents), s.proceedsCents ? money(s.proceedsCents) : "",
          s.shares != null ? s.shares.toFixed(4).replace(/\.?0+$/, "") : "—", s.currentValueCents != null ? money(s.currentValueCents) : "—",
          s.ledgerGainCents != null ? money(s.ledgerGainCents) : "",
        ]),
      ));
    }
    const accts = data.accounts.filter((x) => x.events);
    if (accts.length) {
      out.push(heading("by account"));
      out.push(table(
        [{ head: "ID", align: "r" }, { head: "ACCOUNT" }, { head: "SINCE" }, { head: "CONTRIB", align: "r" }, { head: "IN", align: "r" }, { head: "OUT", align: "r" }, { head: "BOUGHT", align: "r" }, { head: "SOLD", align: "r" }, { head: "DIV+INT", align: "r" }, { head: "FEES", align: "r" }],
        accts.map((x) => [x.accountId, clip(x.account, 26), x.firstActivity ?? "", money(x.contributionCents), money(x.transferInCents), money(x.transferOutCents), money(x.boughtCents), money(x.soldCents), money(x.dividendCents + x.interestCents), money(x.feeCents)]),
      ));
    }
    if (data.funding.length) {
      out.push(heading("where the money came from (contributions and deposits)"));
      out.push(table(
        [{ head: "ACCOUNT" }, { head: "FROM" }, { head: "COUNT", align: "r" }, { head: "AMOUNT", align: "r" }],
        data.funding.map((f) => [clip(f.account, 26), clip(f.label + (f.inferred ? " (inferred)" : ""), 56), f.count, money(f.amountCents)]),
      ));
    }
    out.push("\n  ? after a kind = read from a bare payee name and the sign, not stated by the institution.");
    out.push(kv(data.limits.map((l, i) => [`limit ${i + 1}`, l] as [string, string])));
    return out.join("\n");
  });
}
