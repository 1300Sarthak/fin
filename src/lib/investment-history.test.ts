import { describe, expect, test } from "bun:test";
import { applyFilter, buildEvents, classifyRow, resolveSymbol, summarizeFunding, type AccountMeta, type CounterRow, type HeldPosition, type LedgerRow } from "./investment-history";

const RH: AccountMeta = { id: 6, name: "Robinhood individual (1234)", type: "brokerage", institution: "Robinhood", balanceCents: 0 };
const ROTH: AccountMeta = { id: 10, name: "ROTH IRA (3579)", type: "ira", institution: "Fidelity Investments", balanceCents: 0 };
const K401: AccountMeta = { id: 11, name: "ACME CORP 401(K) PLAN (9012)", type: "ira", institution: "Fidelity Investments", balanceCents: 0 };
const meta = new Map([RH, ROTH, K401].map((a) => [a.id, a]));
let id = 1;
const row = (accountId: number, date: string, amountCents: number, text: string, o: Partial<LedgerRow> = {}): LedgerRow =>
  ({ id: id++, accountId, date, amountCents, text, categoryKind: null, isTransfer: false, transferPairTxnId: null, ...o });
const bank = (cid: number, date: string, amountCents: number, text: string, o: Partial<CounterRow> = {}): CounterRow =>
  ({ id: cid, accountId: 1, account: "7Tamsin (4321)", date, amountCents, text, isTransfer: false, ...o });
const held: HeldPosition[] = [
  { accountId: 6, symbol: "BE", description: "Bloom Energy Corp", shares: 2, marketValueCents: 60000, costPerShareCents: 25000 },
  { accountId: 6, symbol: "AMC", description: "AMC Entertainment Holdings Inc", shares: 70, marketValueCents: 24000, costPerShareCents: 255 },
  { accountId: 10, symbol: "VOO", description: "Vanguard 500 Index Fund", shares: 1, marketValueCents: 60000, costPerShareCents: 50000 },
  { accountId: 10, symbol: "VXUS", description: "Vanguard Total Intl Stock Idx", shares: 1, marketValueCents: 8000, costPerShareCents: 7000 },
  { accountId: 10, symbol: "INTC", description: "Intel Corp", shares: 10, marketValueCents: 50000, costPerShareCents: 4000 },
];

describe("classifyRow", () => {
  const c = (text: string, amountCents: number, inst: string | null = "Robinhood", o: { categoryKind?: string; isTransfer?: boolean } = {}) =>
    classifyRow({ text, amountCents, categoryKind: o.categoryKind ?? null, isTransfer: o.isTransfer ?? false }, inst);
  test("trade text names the security, in each wording the feeds use", () => {
    expect(c("Buy Shares of Bloom Energy for Each", -1000)).toMatchObject({ kind: "buy", security: "Bloom Energy", confidence: "reported" });
    expect(c("Buy X Shares of Nebx for Each", -1000)).toMatchObject({ kind: "buy", security: "Nebx" });
    expect(c("Sell Shares of for Each", 1000)).toMatchObject({ kind: "sell", security: null });
    expect(c("Buy Sol for Each", -1000)).toMatchObject({ kind: "buy", security: "Sol" });
    expect(c("Investment Buy", -1000, "Fidelity Investments")).toMatchObject({ kind: "buy", security: null });
  });
  test("cash events, sweeps and fees", () => {
    expect(c("Cash Contribution Current Year", -300000, "Fidelity Investments").kind).toBe("contribution");
    expect(c("Partic Contr Current Contrb Currener Web Cash", 10000, "Fidelity Investments").kind).toBe("contribution");
    expect(c("Dividend", 55).kind).toBe("dividend");
    expect(c("Interest Income", 67).kind).toBe("interest");
    expect(c("Foreign Tax Paid", -20).kind).toBe("fee");
    expect(c("Fidelity", -479, "Fidelity Investments")).toMatchObject({ kind: "other", internal: true });
    expect(c("Purchase into Fidelity Government Money Market", -116, "Fidelity Investments").internal).toBe(true);
  });
  test("the institution's own name is a transfer; a bare company name is an inferred trade", () => {
    expect(c("Robinhood", 26000)).toMatchObject({ kind: "transfer-in", confidence: "reported" });
    expect(c("Robinhood", -7000, "Robinhood", { isTransfer: true }).kind).toBe("transfer-out");
    expect(c("AMC Theatres", -11997)).toMatchObject({ kind: "buy", security: "AMC Theatres", confidence: "inferred" });
    expect(c("Microsoft", 31020)).toMatchObject({ kind: "sell", confidence: "inferred" });
  });
});

describe("resolveSymbol", () => {
  test("matches one holding by description prefix, ticker, or first word", () => {
    expect(resolveSymbol("Bloom Energy", held)).toBe("BE");
    expect(resolveSymbol("AMC Theatres", held)).toBe("AMC");
    expect(resolveSymbol("Intel", held)).toBe("INTC");
  });
  test("ambiguous or unheld stays null rather than guessed", () => {
    expect(resolveSymbol("Vanguard", held)).toBeNull();
    expect(resolveSymbol("Taiwan Semiconductor Manufacturing", held)).toBeNull();
    expect(resolveSymbol(null, held)).toBeNull();
  });
});

describe("buildEvents", () => {
  test("a contribution booked twice (negative and positive) counts once", () => {
    const neg = row(10, "2026-07-30", -300000, "Cash Contribution Current Year");
    const pos = row(10, "2026-07-30", 300000, "Current Year Contribution");
    const ev = buildEvents([neg, pos], meta, held, [], []);
    expect(ev.find((e) => e.txnId === pos.id)).toMatchObject({ internal: false, duplicateOf: null });
    expect(ev.find((e) => e.txnId === neg.id)).toMatchObject({ internal: true, duplicateOf: pos.id });
  });

  test("two same-day contributions of the same sign are two contributions", () => {
    const a = row(10, "2026-07-30", 50000, "Current Year Contribution");
    const b = row(10, "2026-07-30", 50000, "Current Year Contribution");
    const c = row(10, "2026-07-30", 25000, "Current Year Contribution");
    const ev = buildEvents([a, b, c], meta, held, [], []);
    expect(ev.filter((e) => !e.internal)).toHaveLength(3);
  });

  test("funding: bank outflow naming the institution within 5 days, closest first, used once", () => {
    const a = row(6, "2026-10-23", 15500, "Robinhood");
    const b = row(6, "2026-10-23", 15500, "Robinhood");
    const c = row(6, "2026-11-02", 15500, "Robinhood");
    const counter = [bank(900, "2026-10-20", -15500, "Robinhood"), bank(901, "2026-10-20", -15500, "Robinhood"), bank(902, "2026-10-21", -15500, "Venmo"), bank(903, "2026-10-01", -15500, "Robinhood")];
    const ev = buildEvents([a, b, c], meta, held, counter, []);
    const by = (r: LedgerRow) => ev.find((e) => e.txnId === r.id)!.fundedBy!;
    expect([by(a).txnId, by(b).txnId].sort()).toEqual([900, 901]);
    expect(by(a)).toMatchObject({ kind: "transfer", label: "transfer from 7Tamsin (4321)", inferred: true });
    expect(by(c)).toMatchObject({ kind: "unknown", txnId: null });
  });

  test("401(k) contributions with no bank leg are payroll from the employer the account names", () => {
    const ev = buildEvents([row(11, "2026-11-02", 250000, "Contribution")], meta, held, [], ["Acme"]);
    expect(ev[0].fundedBy).toEqual({ kind: "payroll", label: "payroll (Acme)", txnId: null, accountId: null, inferred: true });
  });

  test("an outflow lands on the transfer-flagged inflow; a declared pair wins over guessing", () => {
    const out = row(6, "2026-08-28", -7000, "Robinhood", { isTransfer: true });
    const card = { ...bank(950, "2026-08-28", 7000, "Payment", { isTransfer: true }), accountId: 20, account: "Robinhood Credit Card (7531)" };
    expect(buildEvents([out], meta, held, [card], [])[0].sentTo).toMatchObject({ label: "to Robinhood Credit Card (7531)", txnId: 950 });
    const dep = row(6, "2026-06-12", 26000, "Robinhood", { transferPairTxnId: 961 });
    const counter = [bank(960, "2026-06-12", -26000, "Robinhood"), { ...bank(961, "2026-06-10", -26000, "SoFi"), accountId: 12, account: "Savings - 9753 (9753)" }];
    expect(buildEvents([dep], meta, held, counter, [])[0].fundedBy).toMatchObject({ txnId: 961, label: "transfer from Savings - 9753 (9753)", inferred: false });
  });
});

describe("applyFilter and summaries", () => {
  const rows = [
    row(6, "2026-06-01", 50000, "Robinhood"),
    row(6, "2026-06-02", -40000, "Buy Shares of Bloom Energy for Each"),
    row(6, "2026-09-02", -10000, "Buy Shares of Bloom Energy for Each"),
    row(6, "2026-09-03", 2000, "Dividend"),
    row(10, "2026-09-09", -30000, "Investment Buy"),
    row(10, "2026-09-09", -30000, "Fidelity"),
    row(10, "2026-09-10", 20000, "Sell Shares of Intel for Each"),
  ];
  const all = buildEvents(rows, meta, held, [], []);
  const metas = [RH, ROTH];

  test("timeline honours every filter and hides internal rows unless asked", () => {
    expect(applyFilter(all, held, metas, { kind: "buy" }).events.map((e) => e.date)).toEqual(["2026-09-09", "2026-09-02", "2026-06-02"]);
    expect(applyFilter(all, held, metas, { from: "2026-09-01", to: "2026-09-09" }).events).toHaveLength(3);
    const r = applyFilter(all, held, metas, { accountId: 10 });
    expect(r.hiddenInternal).toBe(1);
    expect(applyFilter(all, held, metas, { accountId: 10, includeInternal: true }).events).toHaveLength(3);
    expect(applyFilter(all, held, metas, { symbol: "be" }).events.map((e) => e.symbol)).toEqual(["BE", "BE"]);
  });

  test("per-security: first bought is lifetime even under a date filter; gain only when the ledger covers the position", () => {
    const r = applyFilter(all, held, metas, { from: "2026-09-01" });
    const be = r.symbols.find((s) => s.symbol === "BE")!;
    expect(be).toMatchObject({ firstBought: "2026-06-02", buys: 2, investedCents: 50000, shares: 2, currentValueCents: 60000, brokerCostBasisCents: 50000, ledgerGainCents: 10000, brokerGainCents: 10000 });
    // Intel was sold with no buy on record: the position predates the ledger, so no ledger gain.
    expect(r.symbols.find((s) => s.symbol === "INTC")).toMatchObject({ firstBought: null, proceedsCents: 20000, ledgerGainCents: null });
    // A buy that names no security cannot be valued.
    expect(r.symbols.find((s) => s.key === "(unnamed)")).toMatchObject({ investedCents: 30000, ledgerGainCents: null });
  });

  test("account totals by kind, and an account with holdings but no rows is called out", () => {
    const r = applyFilter(all, held, [RH, ROTH, K401], {});
    expect(r.accounts.find((a) => a.accountId === 6)).toMatchObject({ transferInCents: 50000, boughtCents: 50000, dividendCents: 2000, firstActivity: "2026-06-01" });
    const lonely = applyFilter(all, [...held, { accountId: 11, symbol: "7695", description: "FID FRDM 2070", shares: 1, marketValueCents: 100, costPerShareCents: null }], [RH, ROTH, K401], {});
    expect(lonely.limits.some((l) => l.includes("401(K) PLAN") && l.includes("no transactions"))).toBe(true);
  });
});

describe("summarizeFunding", () => {
  test("groups inflows by what paid them, skips duplicates and outflows, unknown stays unknown", () => {
    const a = row(6, "2026-10-23", 15500, "Robinhood");
    const b = row(6, "2026-10-25", 4500, "Robinhood");
    const c = row(6, "2026-10-26", 9900, "Deposit");
    const neg = row(10, "2026-07-30", -300000, "Cash Contribution Current Year");
    const pos = row(10, "2026-07-30", 300000, "Current Year Contribution");
    const buy = row(6, "2026-10-27", -2000, "Buy Shares of Bloom Energy for Each");
    const counter = [bank(900, "2026-10-22", -15500, "Robinhood"), bank(901, "2026-10-24", -4500, "Robinhood")];
    const f = summarizeFunding(buildEvents([a, b, c, neg, pos, buy], meta, held, counter, []));
    expect(f).toEqual([
      { accountId: 6, account: RH.name, kind: "transfer", label: "transfer from 7Tamsin (4321)", inferred: true, amountCents: 20000, count: 2 },
      { accountId: 6, account: RH.name, kind: "unknown", label: "unknown — no matching outflow in a linked account", inferred: false, amountCents: 9900, count: 1 },
      { accountId: 10, account: ROTH.name, kind: "unknown", label: "unknown — no matching outflow in a linked account", inferred: false, amountCents: 300000, count: 1 },
    ]);
  });
});
