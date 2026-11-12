import { describe, expect, test } from "bun:test";
import {
  type Cat,
  type Context,
  type Row,
  aiLine,
  brandKey,
  buildPrecedents,
  decide,
  describe as describeRow,
  findPrecedent,
  ruleHits,
  summaryMessage,
  validateAi,
} from "./categorize-core";

const CATS: Cat[] = [
  { id: 1, name: "Income", kind: "income", parentId: null },
  { id: 2, name: "Paycheck", kind: "income", parentId: 1 },
  { id: 4, name: "Refunds", kind: "income", parentId: 1 },
  { id: 5, name: "Other Income", kind: "income", parentId: 1 },
  { id: 10, name: "Food & Dining", kind: "expense", parentId: null },
  { id: 11, name: "Restaurants", kind: "expense", parentId: 10 },
  { id: 13, name: "Fast Food", kind: "expense", parentId: 10 },
  { id: 9, name: "Groceries", kind: "expense", parentId: null },
  { id: 41, name: "Taxes", kind: "expense", parentId: null },
  { id: 43, name: "Transfers", kind: "transfer", parentId: null },
  { id: 44, name: "Credit Card Payment", kind: "transfer", parentId: 43 },
  { id: 45, name: "Account Transfer", kind: "transfer", parentId: 43 },
  { id: 47, name: "Brokerage", kind: "investment", parentId: null },
  { id: 48, name: "Retirement", kind: "investment", parentId: null },
];
const byName = new Map(CATS.map((c) => [c.name, c]));
const name = (id?: number) => CATS.find((c) => c.id === id)?.name;

const ctx = (over: Partial<Context> = {}): Context => ({
  byName,
  userRules: [],
  systemRules: [],
  incomeSources: [],
  precedents: new Map(),
  cache: new Map(),
  ...over,
});
let nextId = 1;
const row = (over: Partial<Row>): Row => ({
  id: nextId++,
  merchantRaw: "",
  payeeNormalized: "",
  memo: null,
  note: null,
  amountCents: -1000,
  postedAt: new Date(Date.UTC(2026, 9, 14, 12)),
  accountType: "credit",
  isTransfer: false,
  isRecurring: false,
  counterpartType: null,
  ...over,
});

describe("rule matching", () => {
  test("a plain pattern must start at a word", () => {
    expect(ruleHits({ pattern: "ups", isRegex: false }, "the ups store")).toBe(true);
    expect(ruleHits({ pattern: "ups", isRegex: false }, "boba cups co")).toBe(false);
    expect(ruleHits({ pattern: "lime", isRegex: false }, "sublime tea")).toBe(false);
  });
  test("a truncated pattern still matches the longer word", () => {
    expect(ruleHits({ pattern: "brightpath learni", isRegex: false }, "brightpath learning llc")).toBe(true);
  });
  test("a bad regex is skipped, not thrown", () => {
    expect(ruleHits({ pattern: "([", isRegex: true }, "anything")).toBe(false);
  });
});

describe("precedent from the user's history", () => {
  const precedents = buildPrecedents([
    { key: "corner pizza", categoryId: 11, source: "manual" },
    { key: "corner pizza", categoryId: 13, source: "ai" },
    { key: "split brand", categoryId: 11, source: "ai" },
    { key: "split brand", categoryId: 13, source: "ai" },
  ]);

  test("reuses the category the user filed the same merchant under", () => {
    const p = decide(row({ merchantRaw: "Corner Pizza" }), ctx({ precedents }));
    expect(p?.source).toBe("history");
    expect(name(p?.categoryId)).toBe("Restaurants");
  });
  test("a manual correction outweighs an earlier AI guess", () => {
    expect(precedents.get("corner pizza")?.categoryId).toBe(11);
  });
  test("an even split is not a precedent", () => {
    expect(precedents.has("split brand")).toBe(false);
  });
  test("the same brand at another location matches on a whole-word prefix", () => {
    expect(findPrecedent(brandKey("Corner Pizza Springfield"), precedents)?.categoryId).toBe(11);
  });
  test("a generic first word never stands in for a brand", () => {
    const p = buildPrecedents([{ key: "buy", categoryId: 47, source: "manual" }]);
    expect(findPrecedent("buy shares of intel", p)).toBeNull();
  });
  test("an AI or cache label is not a precedent", () => {
    expect(buildPrecedents([{ key: "fidelity", categoryId: 41, source: "ai" }, { key: "fidelity", categoryId: 41, source: "cache" }]).size).toBe(0);
  });
  test("an income precedent is not applied to money going out", () => {
    const p = buildPrecedents([{ key: "acme", categoryId: 2, source: "manual" }]);
    expect(decide(row({ merchantRaw: "Acme", amountCents: -500 }), ctx({ precedents: p }))).toBeNull();
  });
});

describe("built-in structure", () => {
  test("a positive payment on a card is a card payment", () => {
    const p = decide(row({ merchantRaw: "Payment Thank You", amountCents: 50000, accountType: "credit" }), ctx());
    expect(name(p?.categoryId)).toBe("Credit Card Payment");
  });
  test("the checking side of a card payoff is a card payment", () => {
    const p = decide(row({ merchantRaw: "Discover Credit Card", amountCents: -37427, accountType: "checking" }), ctx());
    expect(name(p?.categoryId)).toBe("Credit Card Payment");
  });
  test("a row already flagged as a transfer only ever gets a transfer category", () => {
    const precedents = buildPrecedents([{ key: "robinhood", categoryId: 11, source: "manual" }]);
    const p = decide(row({ merchantRaw: "Robinhood", amountCents: -43222, accountType: "brokerage", isTransfer: true, counterpartType: "credit" }), ctx({ precedents }));
    expect(name(p?.categoryId)).toBe("Credit Card Payment");
  });
  test("a flagged transfer between bank accounts is an account transfer", () => {
    const p = decide(row({ merchantRaw: "Online Transfer", amountCents: 25000, accountType: "checking", isTransfer: true, counterpartType: "savings" }), ctx());
    expect(name(p?.categoryId)).toBe("Account Transfer");
  });
  test("a user rule that would flip a transfer into spending is ignored", () => {
    const p = decide(row({ merchantRaw: "Coinbase", isTransfer: true, accountType: "brokerage" }), ctx({ userRules: [{ pattern: "coinbase", isRegex: false, categoryId: 11, priority: 10 }] }));
    expect(name(p?.categoryId)).toBe("Account Transfer");
  });
  test("own-account moves and money-market sweeps are transfers", () => {
    expect(name(decide(row({ merchantRaw: "From Savings", amountCents: 25000, accountType: "checking" }), ctx())?.categoryId)).toBe("Account Transfer");
    expect(name(decide(row({ merchantRaw: "Purchase into Fidelity Government Money Market", amountCents: -116, accountType: "ira" }), ctx())?.categoryId)).toBe("Account Transfer");
  });
  test("trades follow the account: IRA is retirement, brokerage is brokerage", () => {
    expect(name(decide(row({ merchantRaw: "Buy Shares of Intel for Each", accountType: "ira" }), ctx())?.categoryId)).toBe("Retirement");
    expect(name(decide(row({ merchantRaw: "Buy Shares of Intel for Each", accountType: "brokerage" }), ctx())?.categoryId)).toBe("Brokerage");
  });
  test("an income source's pattern files its deposits by tax treatment", () => {
    const sources = [{ matchPattern: "Acme", taxTreatment: "w2" }, { matchPattern: "Brightpath", taxTreatment: "se" }];
    expect(name(decide(row({ merchantRaw: "ACME PAYROLL", amountCents: 300000, accountType: "checking" }), ctx({ incomeSources: sources }))?.categoryId)).toBe("Paycheck");
    expect(name(decide(row({ merchantRaw: "Brightpath Learni", amountCents: 80000, accountType: "checking" }), ctx({ incomeSources: sources }))?.categoryId)).toBe("Other Income");
    // A purchase at the payer is not income.
    expect(decide(row({ merchantRaw: "Acme store", amountCents: -900, accountType: "credit" }), ctx({ incomeSources: sources }))).toBeNull();
  });
  test("money back onto a card from a shop is a refund, despite the shop's rule", () => {
    const rules = ctx({ userRules: [{ pattern: "best buy", isRegex: false, categoryId: 11, priority: 10 }] });
    expect(name(decide(row({ merchantRaw: "Best Buy", amountCents: 4999, accountType: "credit" }), rules)?.categoryId)).toBe("Refunds");
    expect(decide(row({ merchantRaw: "Cashback Bonus", amountCents: 1254, accountType: "credit" }), ctx())).toBeNull();
  });
  test("payroll words file a deposit as a paycheck", () => {
    expect(name(decide(row({ merchantRaw: "ACME INC DIRECT DEP", amountCents: 250000, accountType: "checking" }), ctx())?.categoryId)).toBe("Paycheck");
  });
  test("an unknown merchant is left for the AI", () => {
    expect(decide(row({ merchantRaw: "Wingstop" }), ctx())).toBeNull();
  });
});

describe("account- and sign-aware rules outrank merchant rules", () => {
  const legacy = ctx({ userRules: [{ pattern: "robinhood", isRegex: false, categoryId: 44, priority: 10 }] });
  test("Robinhood money out of the brokerage is the card being paid", () => {
    expect(name(decide(row({ merchantRaw: "Robinhood", amountCents: -79562, accountType: "brokerage" }), legacy)?.categoryId)).toBe("Credit Card Payment");
  });
  test("Robinhood money into the brokerage is a deposit, despite the merchant rule", () => {
    expect(name(decide(row({ merchantRaw: "Robinhood", amountCents: 15500, accountType: "brokerage" }), legacy)?.categoryId)).toBe("Account Transfer");
  });
  test("money out of a bank to Robinhood is a deposit", () => {
    expect(name(decide(row({ merchantRaw: "Robinhood", amountCents: -15500, accountType: "other" }), legacy)?.categoryId)).toBe("Account Transfer");
  });
  test("a merchant rule leaves that merchant's fee rows alone", () => {
    const rules = ctx({ userRules: [{ pattern: "mercantile", isRegex: false, categoryId: 45, priority: 10 }] });
    expect(name(decide(row({ merchantRaw: "Mercantile", amountCents: -2400, accountType: "checking" }), rules)?.categoryId)).toBe("Account Transfer");
    expect(decide(row({ merchantRaw: "Mercantile S S Springfield Il Fee", amountCents: -250, accountType: "checking" }), rules)).toBeNull();
  });
  test("a posted row inherits its pending hold's category", () => {
    const p = decide(row({ merchantRaw: "Wingstop", pendingCategoryId: 13 }), ctx());
    expect(p?.source).toBe("history");
    expect(name(p?.categoryId)).toBe("Fast Food");
  });
});

describe("what the model is sent", () => {
  test("a person's name in a Zelle descriptor is replaced", () => {
    expect(describeRow("Zelle Transfer from Priya Nair", false)).toBe("Zelle from a person");
    const line = aiLine(row({ id: 7, merchantRaw: "Zelle Transfer to Rohan Iyer Conf# abc123", amountCents: -2000, accountType: "checking" }));
    expect(line).not.toContain("Rohan");
    expect(line).toContain("Zelle to a person");
  });
  test("only the account type is sent, with amount and day", () => {
    const line = aiLine(row({ id: 8, merchantRaw: "Wingstop", amountCents: -3683, accountType: "credit" }));
    expect(line).toBe("8. Wingstop -$36.83 · account: credit · Wed");
  });
  test("bank P2P formats send only the channel", () => {
    for (const raw of ["VENMO *Rahul Mehta", "ZELLE TO MEHTA RAHUL ON 11/02 REF # BAC123", "VENMO PAYMENT 1023456789 RAHUL MEHTA"]) {
      expect(describeRow(raw, false)).not.toMatch(/rahul|mehta/i);
    }
  });
  test("memos and notes never reach the model", () => {
    const line = aiLine(row({ merchantRaw: "Cafe", memo: "Rent to Rahul Mehta", note: "Dinner with Priya Sharma" }));
    expect(line).not.toMatch(/Rahul|Priya/);
  });
  test("an income rule never files money out", () => {
    const sys = ctx({ systemRules: [{ pattern: "payroll", isRegex: false, categoryId: 2, priority: 50 }] });
    expect(decide(row({ merchantRaw: "GUSTO PAYROLL 123", amountCents: -500000, accountType: "checking" }), sys)).toBeNull();
  });
  test("a card credit that is a transfer is not a refund", () => {
    expect(name(decide(row({ merchantRaw: "ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 1234", amountCents: 50000, accountType: "credit", counterpartType: "checking" }), ctx())?.categoryId)).not.toBe("Refunds");
    expect(name(decide(row({ merchantRaw: "ONLINE TRANSFER FROM CHK 1234", amountCents: 50000, accountType: "credit" }), ctx())?.categoryId)).not.toBe("Refunds");
  });
  test("a decided P2P channel key does not swallow every Venmo row", () => {
    const p = buildPrecedents([{ key: "venmo", categoryId: 11, source: "manual" }]);
    expect(findPrecedent(brandKey("VENMO PAYMENT 1023456789"), p)).toBeNull();
  });
});

describe("validating the AI's answer", () => {
  const asked = [
    { id: 1, amountCents: -3000, isTransfer: false },
    { id: 2, amountCents: -3000, isTransfer: false },
    { id: 3, amountCents: -3000, isTransfer: false },
    { id: 4, amountCents: 500, isTransfer: true },
  ];
  test("unknown categories, unknown ids and duplicates are rejected", () => {
    const v = validateAi({ results: [
      { id: 1, category: "Fast Food", confidence: 0.9 },
      { id: 1, category: "Restaurants", confidence: 0.9 },
      { id: 2, category: "Snacks", confidence: 0.9 },
      { id: 99, category: "Groceries", confidence: 0.9 },
    ] }, asked, byName);
    expect(v.accepted).toEqual([{ id: 1, categoryId: 13, confidence: 0.9 }]);
    expect(v.rejected.find((r) => r.id === 2)?.why).toContain("unknown category");
    expect(v.rejected.map((r) => r.id).sort()).toEqual([2, 3, 4]);
  });
  test("an income category on money out and spending on a transfer are refused", () => {
    const v = validateAi({ results: [{ id: 3, category: "Paycheck", confidence: 1 }, { id: 4, category: "Groceries", confidence: 1 }] }, asked, byName);
    expect(v.accepted).toEqual([]);
    expect(v.rejected.map((r) => r.why)).toEqual(["income category on money out", "non-transfer category on a transfer", "no answer", "no answer"]);
  });
  test("low confidence is kept as metadata, never a reason to drop the answer", () => {
    const v = validateAi({ results: [{ id: 1, category: "groceries", confidence: 0.12 }] }, asked, byName);
    expect(v.accepted).toEqual([{ id: 1, categoryId: 9, confidence: 0.12 }]);
  });
  test("an unreadable reply rejects every row instead of throwing", () => {
    expect(validateAi("nope", asked, byName).rejected).toHaveLength(4);
  });
});

test("the summary says what was filed and what is left", () => {
  expect(summaryMessage({ total: 49, categorized: 44, left: 5 })).toBe("Categorized 44, 5 left for you");
  expect(summaryMessage({ total: 0, categorized: 0, left: 0 })).toBe("Everything is already categorized");
  expect(summaryMessage({ total: 9, categorized: 3, left: 6, stopped: true })).toBe("Stopped. Categorized 3, 6 left for you");
});
