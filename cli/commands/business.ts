import { num, pick, str, type Args } from "../args";
import { emit, kv, money, table, clip } from "../render";
import { businessYear, createExpense, EXPENSE_CATEGORIES } from "@/lib/business";
import { SEP_2026 } from "@/lib/sep";

const yearArg = (raw: string | undefined) => {
  if (raw === undefined) return 2026;
  if (!/^\d{4}$/.test(raw)) throw new Error(`expected a YYYY year, got "${raw}"`);
  return Number(raw);
};

/** Dollars to cents; "unknown" (or "?") records a missing price. */
function dollars(k: string, raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (/^(unknown|\?)$/i.test(raw.trim())) return null;
  if (!/^\$?\d+(\.\d{1,2})?$/.test(raw.trim())) throw new Error(`--${k} expects dollars like 249.99 (or "unknown"), got "${raw}"`);
  return Math.round(Number(raw.trim().replace("$", "")) * 100);
}

async function add(a: Args, json: boolean) {
  const item = str(a, "item") ?? a._.slice(1).join(" ");
  if (!item.trim()) throw new Error('Usage: fin business add "ITEM" --amount 249.99 [--date YYYY-MM-DD] [--paid-with TEXT] [--pct 0-100] [--category C] [--txn ID] [--note TEXT] [--year YYYY]');
  const amountCents = dollars("amount", str(a, "amount"));
  if (amountCents === undefined) throw new Error('--amount is required; pass "unknown" if the price is not known yet');
  const id = await createExpense({
    taxYear: yearArg(str(a, "year")),
    item,
    amountCents,
    datePurchased: str(a, "date"),
    paymentMethod: str(a, "paid-with"),
    businessPct: num(a, "pct", { min: 0, max: 100 }) ?? 100,
    category: pick(a, "category", EXPENSE_CATEGORIES),
    txnId: num(a, "txn", { min: 1 }),
    note: str(a, "note"),
  });
  emit(json, { ok: true, id }, () => `  added business expense #${id}: ${item}`);
}

/** `fin business [YEAR]` and `fin business add …`. */
export async function business(a: Args, json: boolean) {
  if (a._[0] === "add") return add(a, json);
  if (a._.length > 1) throw new Error("Usage: fin business [YEAR] | fin business add ITEM --amount N …");
  const y = await businessYear(yearArg(a._[0] ?? str(a, "year")));
  emit(json, y, () => [
    `Business expenses ${y.year} · ${y.totals.count} items, ${y.totals.linkedCount} linked to the ledger`,
    table(
      [{ head: "ID", align: "r" }, { head: "DATE" }, { head: "ITEM" }, { head: "CAT" }, { head: "AMOUNT", align: "r" }, { head: "BIZ", align: "r" }, { head: "DEDUCT", align: "r" }, { head: "TXN", align: "r" }, { head: "FLAGS" }],
      y.expenses.map((e) => [e.id, e.datePurchased ?? "?", clip(e.item, 32), e.category ?? "", e.amountCents == null ? "missing" : money(e.amountCents), `${e.businessPct}%`, money(e.deductibleCents), e.txnId ?? "", e.flags.join("; ")]),
    ),
    "",
    kv([
      ["Spent", money(y.totals.spentCents)],
      ["Deductible", money(y.totals.deductibleCents)],
      ["Missing prices", String(y.totals.missingPriceCount)],
      ["By category", y.byCategory.map((c) => `${c.category} ${money(c.deductibleCents)}`).join(", ") || "—"],
      ["SE income", `${money(y.income.grossCents)}${y.income.nontaxableCents ? ` (+${money(y.income.nontaxableCents)} nontaxable, excluded)` : ""}`],
      ["Net profit", money(y.sep.netProfitCents)],
      ["SEP IRA max", money(y.sep.sep.maxCents)],
    ]),
    ...y.expenses.filter((e) => e.note).map((e) => `  note #${e.id}: ${e.note}`),
    "",
    "Possible business expenses? (not on the list)",
    table([{ head: "TXN", align: "r" }, { head: "DATE" }, { head: "MERCHANT" }, { head: "CATEGORY" }, { head: "AMOUNT", align: "r" }], y.suggestions.map((s) => [s.txnId, s.date, clip(s.merchant, 28), s.category, money(s.amountCents)])),
    "",
    y.disclaimer,
  ].join("\n"));
}

/** `fin sep [YEAR] [--w2-deferrals X]`. */
export async function sep(a: Args, json: boolean) {
  if (a._.length > 1) throw new Error("Usage: fin sep [YEAR] [--w2-deferrals DOLLARS] [--json]");
  const w2 = dollars("w2-deferrals", str(a, "w2-deferrals"));
  const y = await businessYear(yearArg(a._[0] ?? str(a, "year")), { w2DeferralsCents: w2 ?? null });
  const s = y.sep;
  emit(json, { ...s, w2SsWagesCents: y.w2SsWagesCents, disclaimer: y.disclaimer }, () => [
    `SEP IRA ${s.year}`,
    kv([
      ["SE income", money(s.seGrossCents)],
      ["− deductible expenses", money(s.deductibleExpensesCents)],
      ["= net profit", money(s.netProfitCents)],
      ["net SE earnings (×0.9235)", money(s.netSeEarningsCents)],
      ["SS 12.4% on", `${money(s.ssTaxableCents)} → ${money(s.ssTaxCents)} (W-2 wages ${money(y.w2SsWagesCents, false)} ${s.w2Sources.ssWages ?? ""})`],
      ["Medicare 2.9%", money(s.medicareTaxCents)],
      ["SE tax (estimate)", money(s.seTaxCents)],
      ["½ SE tax deduction", money(s.halfSeTaxCents)],
      ["compensation", money(s.compensationCents)],
      ["20% of compensation", money(s.sep.byRateCents)],
      ["25% of comp cap", money(s.sep.byCompCapCents)],
      ["§415(c) limit", money(s.sep.limit415cCents)],
      ["SEP IRA max", money(s.sep.maxCents)],
      ["Solo 401(k) alt", `${money(s.solo401k.totalCents)} = ${money(s.solo401k.employeeCents)} employee + ${money(s.solo401k.employerCents)} employer (402(g) room ${money(s.solo401k.deferralRoomCents)} = ${money(SEP_2026.limit402gCents)} − ${s.solo401k.w2Known ? `${money(s.solo401k.w2DeferralsCents ?? 0)} W-2 401(k), ${s.w2Sources.deferrals}` : "W-2 401(k) deferrals, not entered ($0 assumed)"})`],
      ["Deadline", `${s.deadline.withoutExtension}, or ${s.deadline.withExtension} with an extension`],
    ]),
    ...s.notes.map((n) => `  ${n}`),
    "",
    y.disclaimer,
  ].join("\n"));
}
