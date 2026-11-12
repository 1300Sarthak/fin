import { describe, expect, test } from "bun:test";
import { classifyInvestmentActivity, contributionAmountCents, countedContributions, duplicateContributionLegs } from "./investment-activity";

describe("investment activity classification", () => {
  test("treats negative brokerage cash contributions as contributions, not spending", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Cash Contribution Current Year", categoryName: "Taxes" })).toEqual({ kind: "contribution", label: "Contribution" });
    expect(contributionAmountCents(-250000)).toBe(250000);
  });

  test("keeps 401(k) contributions separate from investment income", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Contribution", categoryName: "Investments", categoryKind: "investment" }).kind).toBe("contribution");
    expect(classifyInvestmentActivity({ merchantRaw: "Dividend", categoryName: "Investments", categoryKind: "investment" }).kind).toBe("investment_income");
  });
});

describe("double-reported contributions", () => {
  const d = (s: string) => new Date(`${s}T12:00:00`);
  const row = (id: number, accountId: number, day: string, amountCents: number, merchantRaw: string, categoryName: string) => ({ id, accountId, postedAt: d(day), amountCents, merchantRaw, categoryName });
  const sum = (rows: { amountCents: number }[]) => rows.reduce((s, r) => s + contributionAmountCents(r.amountCents), 0);

  test("Fidelity's negative + positive pair on one day counts once (Roth 333/579, 398/577; 401k 406/589)", () => {
    const rows = [
      row(333, 10, "2026-07-30", -300000, "Cash Contribution Current Year", "Taxes"),
      row(579, 10, "2026-07-30", 300000, "Current Year Contribution", "Investments"),
      row(398, 10, "2026-08-13", -290000, "Cash Contribution Current Year", "Taxes"),
      row(577, 10, "2026-08-13", 290000, "Current Year Contribution", "Investments"),
      row(570, 10, "2026-09-09", 160000, "Current Year Contribution", "Investments"),
      row(406, 11, "2026-08-14", -50000, "Contribution", "Investments"),
      row(589, 11, "2026-08-14", 50000, "Contribution", "Investments"),
    ];
    const kept = countedContributions(rows);
    expect(kept.map((r) => r.id).sort()).toEqual([570, 577, 579, 589]);
    expect(sum(kept.filter((r) => r.accountId === 10))).toBe(750000); // $7,500, the 2026 Roth limit
    expect(duplicateContributionLegs([{ id: 333, accountId: 10, day: "2026-07-30", amountCents: -300000 }, { id: 579, accountId: 10, day: "2026-07-30", amountCents: 300000 }])).toEqual(new Map([[333, 579]]));
  });

  test("two real contributions on one day are both counted", () => {
    expect(countedContributions([row(1, 10, "2026-07-30", 50000, "Contribution", "Investments"), row(2, 10, "2026-07-30", 25000, "Contribution", "Investments")])).toHaveLength(2);
    // Same size, same sign: still two deposits, not a double report.
    expect(countedContributions([row(1, 10, "2026-07-30", 50000, "Contribution", "Investments"), row(2, 10, "2026-07-30", 50000, "Contribution", "Investments")])).toHaveLength(2);
  });

  test("a lone negative contribution (prior-year, no twin) still counts", () => {
    expect(sum(countedContributions([row(135, 10, "2026-04-13", -300000, "Cash Contribution Prior Year", "Investments")]))).toBe(300000);
  });

  test("opposite legs on different days or in different accounts are not merged", () => {
    expect(countedContributions([row(1, 10, "2026-07-30", -50000, "Contribution", "x"), row(2, 10, "2026-07-31", 50000, "Contribution", "x")])).toHaveLength(2);
    expect(countedContributions([row(1, 10, "2026-07-30", -50000, "Contribution", "x"), row(2, 11, "2026-07-30", 50000, "Contribution", "x")])).toHaveLength(2);
  });

  test("each leg pairs at most once", () => {
    const kept = countedContributions([row(1, 10, "2026-07-30", -50000, "Contribution", "x"), row(2, 10, "2026-07-30", 50000, "Contribution", "x"), row(3, 10, "2026-07-30", 50000, "Contribution", "x")]);
    expect(kept.map((r) => r.id)).toEqual([2, 3]);
  });
});

describe("money-market sweep legs", () => {
  test("a bare \"Fidelity\" row tagged Fees & Charges is a sweep, not a fee (HSA +$99.55, txn 585)", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Fidelity", categoryName: "Fees & Charges", categoryKind: "expense" })).toEqual({ kind: "trade", label: "Cash sweep" });
    expect(classifyInvestmentActivity({ merchantRaw: "FIDELITY GOVT MONEY MARKET", categoryName: "Fees & Charges" }).kind).toBe("trade");
  });

  test("real fees and money-market dividends keep their kind", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Advisory Fee", categoryName: "Fees & Charges" }).kind).toBe("fee");
    expect(classifyInvestmentActivity({ merchantRaw: "Fidelity Investments", categoryName: "Fees & Charges" }).kind).toBe("fee");
    expect(classifyInvestmentActivity({ merchantRaw: "Dividend Received FIDELITY GOVERNMENT MONEY MARKET", categoryName: "Investments" }).kind).toBe("investment_income");
  });

  test("Fidelity HSA payroll contribution text is a contribution", () => {
    expect(classifyInvestmentActivity({ merchantRaw: "Partic Contr Current Contrb Currener Web Cash", categoryName: "Investments" }).kind).toBe("contribution");
  });
});
