/**
 * Commands that answer "what happened to the money": balances, cash flow,
 * spending, and the burn-rate report.
 */
import { bool, month, num, pick, RANGE, str, shiftMonth, type Args } from "../args";
import { clip, emit, heading, kv, money, pct, signed, table } from "../render";
import { getBurnReport, allocate, type FlowKind } from "@/lib/burn";
import { getNetWorthSummary } from "@/lib/networth";
import { getAccountsWithInstitution, getTransactions } from "@/lib/queries";
import {
  monthRange,
  getCashflow,
  getSpendingByCategory,
  getSpendingByAccount,
  getTopMerchants,
  getMonthlyTrend,
  getBudgetsWithActual,
} from "@/lib/spending";
import { getEarningsWorkspace, getInvestmentsWorkspace, getTransfersWorkspace } from "@/lib/workspaces";
import { getRefunds } from "@/lib/refunds";
import { getPeriodHistory } from "@/lib/history";
import { applyCashOp, dateFromInput, getCashAccount, getCashActivity, parseCashCommand } from "@/lib/cash";
import { looksLikeSet, parseCashText } from "@/lib/cash-core";
import { balanceAge } from "@/lib/accounts";
import { netWorthLine } from "../netchange";

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function overview(a: Args, json: boolean) {
  const m = month(str(a, "month") ?? a._[0]);
  const [nw, flow] = await Promise.all([getNetWorthSummary({ range: "1M" }), getBurnReport(m)]);
  const f = flow.total;
  const data = { netWorth: nw.net, assets: nw.assets, liabilities: nw.liabilities, liquid: nw.liquidMoney, month: m, flow: f };
  emit(json, data, () =>
    [
      kv([
        ["Net worth", netWorthLine(nw)],
        ["Assets / debts", `${money(nw.assets)} / ${money(nw.liabilities)}`],
        ["Spendable now", money(nw.liquidMoney.liquidAssetsCents)],
      ]),
      heading(`${m} so far`),
      kv([
        ["Earned", `${money(f.earnedCents)}${f.pretaxCents ? ` (incl. ${money(f.pretaxCents)} pre-tax)` : ""}`],
        ["Net spending", money(f.netSpendCents)],
        ["Saved", `${money(f.savedCents)}  (${pct(f.savingsRatePct)} of take-home)`],
        ["Burn rate", pct(f.burnPct)],
      ]),
    ].join("\n"),
  );
}

export async function accounts(a: Args, json: boolean) {
  const rows = await getAccountsWithInstitution();
  const showAll = bool(a, "all");
  const visible = rows.filter((r) => showAll || r.currentBalanceCents !== 0);
  emit(json, visible, () =>
    table(
      [{ head: "ID", align: "r" }, { head: "ACCOUNT" }, { head: "TYPE" }, { head: "BALANCE", align: "r" }, { head: "AS OF" }],
      visible.map((r) => {
        const age = balanceAge(r.balanceDate ?? null);
        return [
          r.id,
          clip(`${r.institution?.name ? `${r.institution.name} ` : ""}${r.name}`, 42),
          r.isAsset ? r.type : `${r.type} (debt)`,
          money(r.currentBalanceCents),
          r.balanceDate ? `${day(r.balanceDate)}${age?.isStale ? " stale" : ""}` : "manual",
        ];
      }),
    ),
  );
}

const KIND_ORDER: FlowKind[] = ["income", "contribution", "pretax", "spend", "refund", "reimbursement", "internal", "market", "excluded"];

export async function burn(a: Args, json: boolean) {
  const from = month(a._[0] ?? shiftMonth(month(undefined), -2));
  const to = month(a._[1] ?? month(undefined));
  if (from > to) throw new Error(`FROM ${from} is after TO ${to} — usage: fin burn 2026-06 2026-08`);
  const only = pick(a, "kind", KIND_ORDER);
  const report = await getBurnReport(from, to);
  const alloc = allocate(report);
  // With no months in range the total is a placeholder carrying a month key,
  // which prints as a row indistinguishable from a real month of zeroes.
  const hasData = report.months.length > 0;

  if (json) return emit(true, { ...report, hasData, total: hasData ? report.total : null, allocation: alloc }, () => "");
  if (!hasData) {
    return console.log(`  no data — nothing recorded between ${from} and ${to}`);
  }

  const cols = [
    { head: "MONTH" },
    { head: "EARNED", align: "r" as const },
    { head: "TAKE-HOME", align: "r" as const },
    { head: "GROSS OUT", align: "r" as const },
    { head: "CREDITS", align: "r" as const },
    { head: "NET SPENT", align: "r" as const },
    { head: "SAVED", align: "r" as const },
    { head: "BURN", align: "r" as const },
  ];
  const line = (m: (typeof report.months)[number]) => [
    m.month,
    money(m.earnedCents),
    money(m.takeHomeCents),
    money(m.grossSpendCents),
    money(m.refundCents + m.reimbursementCents),
    money(m.netSpendCents),
    money(m.savedCents),
    pct(m.burnPct),
  ];

  const out = [
    table(cols, [...report.months.map(line), line(report.total)]),
    heading("Where it went"),
    table(
      [{ head: "DESTINATION" }, { head: "AMOUNT", align: "r" }, { head: "SHARE", align: "r" }],
      alloc.map((x) => [clip(x.name, 40), money(x.cents), pct(x.pct)]),
    ),
  ];

  const cash = report.total.cashSpendCents;
  if (cash) {
    out.push(
      heading("Physical cash"),
      kv([
        ["Cash spending", money(cash)],
        ["Net spend excl. cash", money(report.total.netSpendCents - cash)],
        ["Burn excl. cash", pct(report.total.burnExCashPct)],
      ]),
    );
  }

  if (bool(a, "explain") || only) {
    const rows = report.rows
      .filter((r) => (only ? r.kind === only : r.kind !== "spend"))
      .sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.date.localeCompare(y.date));
    out.push(
      heading(`How each row was classified${only ? ` (${only})` : " (spend rows omitted; --kind spend to see them)"}`),
      table(
        [{ head: "ID", align: "r" }, { head: "DATE" }, { head: "ACCOUNT" }, { head: "AMOUNT", align: "r" }, { head: "MERCHANT" }, { head: "KIND" }, { head: "WHY" }],
        rows.map((r) => [r.id, r.date, clip(r.account, 24), money(r.amountCents), clip(r.merchant, 30), r.kind, r.reason]),
      ),
    );
  }
  console.log(out.join("\n"));
}

export async function spending(a: Args, json: boolean) {
  const m = month(str(a, "month") ?? a._[0]);
  const r = monthRange(m);
  const by = pick(a, "by", ["category", "merchant", "card", "account"] as const) ?? "category";
  const limit = num(a, "limit", RANGE.limit) ?? 15;
  const flow = await getCashflow(r);

  if (by === "merchant") {
    const rows = await getTopMerchants(r, limit);
    return emit(json, rows, () =>
      table(
        [{ head: "MERCHANT" }, { head: "SPENT", align: "r" }, { head: "N", align: "r" }],
        rows.map((x) => [clip(x.merchant, 34), money(x.spentCents), x.count]),
      ),
    );
  }
  if (by === "card" || by === "account") {
    const rows = await getSpendingByAccount(r);
    return emit(json, rows, () =>
      table(
        [{ head: "ACCOUNT" }, { head: "SPENT", align: "r" }, { head: "REFUNDED", align: "r" }, { head: "N", align: "r" }],
        rows.map((x) => [clip(x.name, 34), money(x.spentCents), money(x.refundedCents), x.count]),
      ),
    );
  }
  const rows = await getSpendingByCategory(r);
  emit(json, { cashflow: flow, categories: rows }, () =>
    [
      kv([
        ["Made", money(flow.incomeCents)],
        ["Spent", money(flow.spendingCents)],
        ["Net", signed(flow.net)],
      ]),
      heading(`${r.label} by category`),
      table(
        [{ head: "CATEGORY" }, { head: "SPENT", align: "r" }, { head: "SHARE", align: "r" }, { head: "N", align: "r" }],
        rows.slice(0, limit).map((x) => [clip(x.name, 28), money(x.spentCents), pct(x.pct * 100), x.count]),
      ),
    ].join("\n"),
  );
}

export async function txns(a: Args, json: boolean) {
  const m = str(a, "month");
  const r = m ? monthRange(month(m)) : undefined;
  const rows = await getTransactions({
    q: str(a, "search") ?? a._[0],
    accountId: num(a, "account", RANGE.id),
    categoryId: str(a, "category") === "none" ? "none" : num(a, "category", RANGE.id),
    since: r?.start,
    until: r?.end,
    amountType: pick(a, "type", ["income", "expense"] as const),
    limit: num(a, "limit", RANGE.limit) ?? 25,
  });
  emit(json, rows, () =>
    table(
      [{ head: "ID", align: "r" }, { head: "DATE" }, { head: "MERCHANT" }, { head: "AMOUNT", align: "r" }, { head: "CATEGORY" }, { head: "ACCOUNT" }, { head: "FLAGS" }],
      rows.map((t) => [
        t.id,
        day(t.postedAt),
        clip(t.merchantRaw, 32),
        money(t.amountCents),
        clip(t.category?.name ?? "—", 18),
        clip(t.account?.name ?? "", 20),
        [t.isTransfer && "transfer", t.isRefund && "refund", t.isExcluded && "excluded", t.isPending && "pending"].filter(Boolean).join(","),
      ]),
    ),
  );
}

export async function earnings(a: Args, json: boolean) {
  const w = await getEarningsWorkspace(str(a, "month") ?? a._[0]);
  emit(json, w, () =>
    [
      kv([
        ["Month", w.monthLabel],
        ["Cash income", money(w.monthCents)],
        ["Into retirement", money(w.monthRetirementContributionCents)],
        ["Earned + invested", money(w.monthEarnedAndInvestedCents)],
        ["Monthly average", money(w.averageMonthlyCents)],
      ]),
      heading("Sources"),
      table(
        [{ head: "SOURCE" }, { head: "AMOUNT", align: "r" }, { head: "N", align: "r" }],
        w.sources.map((s) => [clip(s.name, 34), money(s.valueCents), s.count ?? ""]),
      ),
      heading("Trend"),
      table(
        [{ head: "MONTH" }, { head: "INCOME", align: "r" }],
        w.trend.map((t) => [t.month, money(t.valueCents)]),
      ),
    ].join("\n"),
  );
}

export async function investments(_a: Args, json: boolean) {
  const w = await getInvestmentsWorkspace();
  emit(json, w, () =>
    [
      kv([
        ["Total invested value", money(w.totalCents)],
        ["Contributions", `${money(w.contributionCents)} across ${w.contributionCount}`],
        ["Investment income", money(w.investmentIncomeCents)],
        ["Withdrawals / fees", `${money(w.withdrawalCents)} / ${money(w.feeCents)}`],
      ]),
      heading("Accounts"),
      table(
        [{ head: "ACCOUNT" }, { head: "TYPE" }, { head: "VALUE", align: "r" }],
        w.accounts.map((x) => [clip(`${x.institution ? `${x.institution} ` : ""}${x.name}`, 40), x.type, money(x.balanceCents)]),
      ),
    ].join("\n"),
  );
}

export async function transfers(a: Args, json: boolean) {
  const w = await getTransfersWorkspace();
  const limit = num(a, "limit", RANGE.limit) ?? 20;
  emit(json, w, () =>
    [
      kv([
        ["Moved between accounts", money(w.totalCents)],
        ["Matched / unpaired", `${w.matchedCount} / ${w.unpairedCount}`],
      ]),
      heading("Recent"),
      table(
        [{ head: "DATE" }, { head: "ACCOUNT" }, { head: "DIR" }, { head: "AMOUNT", align: "r" }, { head: "COUNTERPARTY" }],
        w.transfers.slice(0, limit).map((t) => [
          day(t.postedAt),
          clip(t.accountName, 28),
          t.amountCents < 0 ? "out" : "in",
          money(Math.abs(t.amountCents)),
          // An unpaired leg still names its counterparty in the description,
          // which is more use than printing a question mark.
          clip(t.pairedAccountName ?? `${t.merchantRaw} (unpaired)`, 34),
        ]),
      ),
    ].join("\n"),
  );
}

export async function refunds(a: Args, json: boolean) {
  const rows = await getRefunds();
  const limit = num(a, "limit", RANGE.limit) ?? 20;
  emit(json, rows, () =>
    table(
      [{ head: "ID", align: "r" }, { head: "DATE" }, { head: "MERCHANT" }, { head: "AMOUNT", align: "r" }, { head: "REVERSES" }],
      rows.slice(0, limit).map((r) => [
        r.id,
        day(r.postedAt),
        clip(r.merchantRaw, 30),
        money(r.amountCents),
        r.refundsTransaction ? `#${r.refundsTransaction.id} ${clip(r.refundsTransaction.merchantRaw, 24)}` : "unlinked",
      ]),
    ),
  );
}

export async function trend(a: Args, json: boolean) {
  const rows = await getMonthlyTrend(num(a, "months", RANGE.months) ?? 6);
  emit(json, rows, () =>
    // This is the spendable-accounts view, matching the dashboard. Pay routed
    // straight into a brokerage is not income here — `fin burn` counts that.
    "  income as it landed in spendable accounts; see `fin burn` for true earnings\n" +
    table(
      [{ head: "MONTH" }, { head: "INCOME", align: "r" }, { head: "SPENT", align: "r" }, { head: "NET", align: "r" }],
      rows.map((t) => [t.month, money(t.income), money(t.expense), signed(t.income - t.expense)]),
    ),
  );
}

export async function budgets(a: Args, json: boolean) {
  const rows = await getBudgetsWithActual(monthRange(month(str(a, "month") ?? a._[0])));
  emit(json, rows, () =>
    table(
      [{ head: "CATEGORY" }, { head: "LIMIT", align: "r" }, { head: "SPENT", align: "r" }, { head: "LEFT", align: "r" }],
      rows.map((b) => [clip(b.name, 28), money(b.limitCents), money(b.spentCents), money(b.limitCents - b.spentCents)]),
    ),
  );
}

export async function history(a: Args, json: boolean) {
  const rows = await getPeriodHistory(pick(a, "period", ["month", "week"] as const) ?? "month");
  const limit = num(a, "limit", RANGE.limit) ?? 12;
  emit(json, rows, () =>
    table(
      [{ head: "PERIOD" }, { head: "NET WORTH", align: "r" }, { head: "CHANGE", align: "r" }, { head: "INCOME", align: "r" }, { head: "SPENT", align: "r" }, { head: "SAVED", align: "r" }],
      rows.slice(0, limit).map((p) => [
        p.label,
        money(p.netWorthCents),
        signed(p.changeCents),
        money(p.incomeCents),
        money(p.spendingCents),
        signed(p.savedCents),
      ]),
    ),
  );
}

/** Anything but a read is a write to the running total, so read it twice. */
const CASH_EXAMPLES = "Try: fin cash add 40 tips · fin cash spent 15 on lunch · fin cash set 500. Bare `fin cash` only reads the balance.";
/** The library message already carries examples; only the read-only hint is new. */
const CASH_TAIL = "Bare `fin cash` only reads the balance.";

export async function cash(a: Args, json: boolean) {
  const [verb, ...rest] = a._;
  if (verb && verb !== "show") {
    const text = [verb, ...rest].join(" ");
    // The deterministic parser refuses anything it cannot read as add /
    // subtract / set, so run it first: a phrase that fails here never reaches
    // a provider, and never becomes `set <the stray number in it>`.
    let local;
    try {
      local = parseCashText(text);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${CASH_TAIL}`);
    }
    const cmd = await parseCashCommand(text);
    // `set` discards the balance rather than adjusting it, so it needs
    // evidence in the text the caller typed — not just the model's opinion.
    if (cmd.op === "set" && !looksLikeSet(text)) {
      throw new Error(`refusing to set cash from "${text}": nothing in it says the total is being replaced, and a set discards the running balance. ${CASH_EXAMPLES}`);
    }
    if (cmd.amountCents <= 0 && local.amountCents > 0) {
      throw new Error(`refusing to apply "${text}": it names ${money(local.amountCents)} but was read as ${cmd.op} ${money(cmd.amountCents)}. ${CASH_EXAMPLES}`);
    }
    const result = await applyCashOp(cmd.op, cmd.amountCents, cmd.note, cmd.date ? dateFromInput(cmd.date) : new Date());
    return emit(json, result, () =>
      kv([
        ["Applied", `${result.op} ${money(result.amountCents)}${result.note ? ` — ${result.note}` : ""}`],
        ["Cash on hand", money(result.balanceCents)],
      ]),
    );
  }
  const [account, activity] = await Promise.all([getCashAccount(), getCashActivity(num(a, "limit", RANGE.limit) ?? 15)]);
  emit(json, { account, activity }, () =>
    [
      kv([["Cash on hand", money(account?.currentBalanceCents ?? 0)]]),
      heading("Recent"),
      table(
        [{ head: "ID", align: "r" }, { head: "DATE" }, { head: "WHAT" }, { head: "AMOUNT", align: "r" }],
        activity.map((t) => [t.id, day(t.postedAt), clip(t.note ?? t.merchantRaw, 40), money(t.amountCents)]),
      ),
    ].join("\n"),
  );
}
