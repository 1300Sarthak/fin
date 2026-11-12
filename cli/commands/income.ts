import { num, str, month, isoDay, pick, type Args } from "../args";
import { clip, emit, heading, kv, money, table } from "../render";
import { addEntry, getIncomeDetails, getIncomeOverview, getIncomeRange, rangeDay, type IncomeRange, type SourceSummary } from "../../src/lib/income";
import { getEarningsRange } from "../../src/lib/workspaces";
import { isoDate } from "../../src/lib/format";
import { getTakeHome, saveTakeHomeInputs, type TakeHome } from "../../src/lib/take-home";

const USAGE = "usage: fin income [YEAR] [--source NAME] | fin income earnings [--from YYYY-MM[-DD]] [--to YYYY-MM[-DD]] | fin income [YEAR] --from YYYY-MM[-DD] --to YYYY-MM[-DD] [--by week|month|quarter|year] [--basis paid|work] [--source A,B,Other] | fin income log SOURCE --month YYYY-MM --hours N [--amount X] [--paid YYYY-MM-DD] [--txn ID]";
const RANGE_FLAGS = ["from", "to", "by", "basis"];

/** Dollars as typed ("462.50", "$1,300") to cents; anything else is an error, not a zero. */
function dollars(raw: string): number {
  const v = Number(raw.replace(/[$,]/g, "").trim());
  if (!raw.trim() || !Number.isFinite(v) || v < 0) throw new Error(`--amount expects dollars, got "${raw}"`);
  return Math.round(v * 100);
}

function hoursFlag(a: Args): number | undefined {
  const raw = str(a, "hours");
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!raw.trim() || !Number.isFinite(v) || v < 0 || v > 744) throw new Error(`--hours expects 0-744, got "${raw}"`);
  return v;
}

async function log(a: Args, json: boolean) {
  const source = a._.slice(1).join(" ").trim();
  if (!source) throw new Error(USAGE);
  for (const f of RANGE_FLAGS) if (a.flags[f] !== undefined) throw new Error(`--${f} does not apply to fin income log`);
  const workMonth = str(a, "month");
  const amount = str(a, "amount");
  const paid = str(a, "paid");
  const hours = hoursFlag(a);
  if (hours === undefined && amount === undefined && !str(a, "txn")) throw new Error(`give --hours, --amount, or --txn — ${USAGE}`);
  const row = await addEntry({
    source,
    workMonth: workMonth ? month(workMonth) : undefined,
    hours,
    amountCents: amount !== undefined ? dollars(amount) : undefined,
    paidOn: paid ? isoDay(paid, "--paid") : undefined,
    txnId: num(a, "txn", { min: 1 }),
  });
  emit(json, row, () => `  logged entry #${row.id} — ${source} ${row.workMonth ?? ""} ${row.hours != null ? `${row.hours}h ` : ""}${money(row.amountCents)}${row.paidOn ? `, paid ${row.paidOn}` : ", unpaid"}${row.txnId ? ` (txn ${row.txnId})` : ""}`);
}

function printSource(s: SourceSummary): string {
  const label = { w2: "W-2", se: "self-employment", nontaxable: "nontaxable" }[s.source.taxTreatment];
  const out = [heading(`${s.source.name} (${label}${s.source.matchPattern ? `, matches "${s.source.matchPattern}"` : ""}) — ${money(s.totalCents)}`)];
  const facts: [string, string][] = [];
  if (s.nontaxableCents) facts.push(["taxable / non", `${money(s.taxableCents)} / ${money(s.nontaxableCents)}`]);
  if (s.hours) facts.push(["hours", `${s.hours}h at ${money(s.effectiveRateCents ?? 0)}/h effective${s.source.hourlyRateCents ? `, current ${money(s.source.hourlyRateCents)}/h` : ""}`]);
  if (s.typicalLagDays != null) facts.push(["typical lag", `${s.typicalLagDays} days after month end`]);
  if (s.owedCents) facts.push(["owed", `${money(s.owedCents)} — ${s.owed.map((o) => `${o.workMonth ?? "?"} ${money(o.amountCents)} expected ${o.expectedOn ?? "?"}${o.overdue ? " OVERDUE" : ""}`).join("; ")}`]);
  if (s.unloggedMonths.length) facts.push(["not logged", s.unloggedMonths.join(", ")]);
  if (facts.length) out.push(kv(facts));
  if (s.entries.length) {
    out.push(table(
      [{ head: "ID", align: "r" }, { head: "WORK" }, { head: "HOURS", align: "r" }, { head: "RATE", align: "r" }, { head: "EARNED", align: "r" }, { head: "PAID" }, { head: "DAYS", align: "r" }, { head: "TXN", align: "r" }, { head: "NOTE" }],
      s.entries.map((e) => [e.id, e.workMonth ?? "-", e.hours ?? "", e.rateCents ? money(e.rateCents) : "", money(e.amountCents) + (e.bucket === "nontaxable" ? "*" : ""), e.paidOn ?? "unpaid", e.daysToPay ?? "", e.txnId ?? "", clip(e.note ?? "", 36)]),
    ));
  }
  if (s.depositMonths.length) {
    out.push(table([{ head: "MONTH" }, { head: "DEPOSITS", align: "r" }, { head: "NET PAY", align: "r" }],
      s.depositMonths.map((m) => [m.month, m.txnIds.length, money(m.cents)])));
  }
  if (s.unmatched.length) {
    out.push(`  unmatched deposits (no entry links them — fin income log ${s.source.name} --month YYYY-MM --txn ID):`);
    out.push(table([{ head: "TXN", align: "r" }, { head: "DATE" }, { head: "AMOUNT", align: "r" }, { head: "ACCOUNT" }],
      s.unmatched.map((d) => [d.id, d.date, money(d.amountCents), clip(d.account, 24)])));
  }
  return out.join("\n");
}

const signedPct = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/** Any stretch of time: one column per job (plus Other), one row per period. */
async function range(a: Args, json: boolean, year: string | undefined) {
  if (year && (a.flags.from !== undefined || a.flags.to !== undefined)) throw new Error("give a YEAR or --from/--to, not both");
  const sources = str(a, "source")?.split(",").map((s) => s.trim()).filter(Boolean);
  const data = await getIncomeRange({
    from: year ? `${year}-01` : str(a, "from"),
    to: year ? `${year}-12` : str(a, "to"),
    groupBy: pick(a, "by", ["week", "month", "quarter", "year"] as const),
    basis: pick(a, "basis", ["paid", "work"] as const),
    sources,
  });
  if (json) return emit(json, { ...data, jobs: await getIncomeDetails(data.from, data.to, { sources: sources?.filter((x) => x.toLowerCase() !== "other") }) }, () => "");
  const detail = await printWindowDetail(data.from, data.to, sources);
  emit(json, data, () => [printRange(data), detail && heading("job detail"), detail].filter(Boolean).join("\n"));
}

function printRange(r: IncomeRange): string {
  const t = r.totals, p = r.previous;
  const facts: [string, string][] = [
    [`total ${r.from} to ${r.to}`, money(t.total)],
    ["W-2 (net pay)", money(t.w2)],
    ["self-employment", money(t.se)],
    ["nontaxable", money(t.nontaxable)],
    ["other money in", `${money(t.other)}  (no source claims it; tax treatment unknown)`],
    ["hours", t.hours ? `${t.hours}h, ${money(t.avgRateCents ?? 0)}/h average` : "none logged"],
    [`vs ${p.from} to ${p.to}`, `${money(p.totals.total)}  (${p.deltaCents >= 0 ? "+" : ""}${money(p.deltaCents)}, ${signedPct(p.deltaPct)})`],
  ];
  const out = [kv(facts)];
  const cols = [...r.sources.map((s) => s.name), ...(r.periods[0] && "Other" in r.periods[0].bySource ? ["Other"] : [])];
  out.push(heading(`by ${r.groupBy}, ${r.basis} basis`));
  out.push(table([{ head: r.groupBy.toUpperCase() }, ...cols.map((c) => ({ head: c.toUpperCase(), align: "r" as const })), { head: "TOTAL", align: "r" }],
    r.periods.map((x) => [x.label, ...cols.map((c) => money(x.bySource[c] ?? 0)), money(x.total)])));
  const jobs = r.sources.filter((s) => s.totalCents || s.hours || s.unmatched.length);
  if (jobs.length) {
    out.push(heading("by job"));
    out.push(table([{ head: "JOB" }, { head: "TREATMENT" }, { head: "TOTAL", align: "r" }, { head: "HOURS", align: "r" }, { head: "RATE", align: "r" }, { head: "UNPAID", align: "r" }, { head: "UNMATCHED", align: "r" }],
      jobs.map((s) => [s.name, s.taxTreatment, money(s.totalCents), s.hours || "", s.effectiveRateCents ? `${money(s.effectiveRateCents)}/h` : "", s.unpaidCents ? money(s.unpaidCents) : "", s.unmatched.length || ""])));
  }
  if (r.other.byCategory.length) {
    out.push(heading("other money in, by category"));
    out.push(table([{ head: "CATEGORY" }, { head: "ROWS", align: "r" }, { head: "AMOUNT", align: "r" }], r.other.byCategory.map((c) => [c.category, c.count, money(c.totalCents)])));
  }
  if (r.refunds.byCategory.length) {
    out.push(heading(`refunds & reimbursements — ${money(r.refunds.totalCents)}, not counted as income`));
    out.push(table([{ head: "CATEGORY" }, { head: "ROWS", align: "r" }, { head: "AMOUNT", align: "r" }], r.refunds.byCategory.map((c) => [c.category, c.count, money(c.totalCents)])));
  }
  out.push(...r.notes.map((n) => `\n  ${n}`));
  return out.join("\n");
}

/** `fin income earnings [--from … --to …]`: the Earnings tab — cash that landed plus retirement deposits, for any range. */
async function earnings(a: Args, json: boolean) {
  if (a._.length > 1) throw new Error("usage: fin income earnings [--from YYYY-MM[-DD]] [--to YYYY-MM[-DD]]");
  for (const f of ["month", "hours", "amount", "paid", "txn", "by", "basis", "source"]) if (a.flags[f] !== undefined) throw new Error(`--${f} does not apply to fin income earnings`);
  const from = str(a, "from"), to = str(a, "to");
  const r = await getEarningsRange(from ? rangeDay(from, "start") : null, to ? rangeDay(to, "end") : null);
  emit(json, r, () => [
    kv([
      [`cash income ${r.from} to ${r.to}`, money(r.rangeCents)],
      ["retirement deposited", `${money(r.retirementCents)}  (Roth IRA / 401(k), double-reported legs counted once)`],
      ["earned & invested", money(r.earnedAndInvestedCents)],
      ["average month (trend window)", money(r.averageMonthlyCents)],
      ["all recorded cash income", money(r.totalCents)],
      ["all retirement deposits", `${money(r.retirementContributionCents)} across ${r.retirementContributionCount}`],
    ]),
    heading("by source"),
    table([{ head: "SOURCE" }, { head: "ROWS", align: "r" }, { head: "AMOUNT", align: "r" }], r.sources.map((x) => [clip(x.name, 32), x.count ?? "", money(x.valueCents)])),
    heading("by account"),
    table([{ head: "ACCOUNT" }, { head: "ROWS", align: "r" }, { head: "AMOUNT", align: "r" }], r.accounts.map((x) => [clip(x.name, 32), x.count ?? "", money(x.valueCents)])),
    heading("by month"),
    table([{ head: "MONTH" }, { head: "CASH", align: "r" }, { head: "RETIREMENT", align: "r" }], r.trend.map((p) => [p.month, money(p.valueCents), money(p.secondaryCents ?? 0)])),
    r.contributions.length ? heading("retirement deposits") : "",
    r.contributions.length ? table([{ head: "TXN", align: "r" }, { head: "DATE" }, { head: "ACCOUNT" }, { head: "AMOUNT", align: "r" }], r.contributions.map((c) => [c.id, isoDate(c.postedAt), clip(c.accountName, 30), money(c.amountCents)])) : "",
  ].filter(Boolean).join("\n"));
}

/** Per-job detail for a window (entries, owed, lag, unlogged months) — what the Income page's job sections show. */
async function printWindowDetail(from: string, to: string, sources?: string[]): Promise<string> {
  const details = await getIncomeDetails(from, to, { sources: sources?.filter((s) => s.toLowerCase() !== "other") });
  return details.filter((s) => s.entries.length || s.depositMonths.length || s.unmatched.length || s.owed.length || s.unloggedMonths.length).map(printSource).join("\n");
}

export async function income(a: Args, json: boolean) {
  if (a._[0] === "log") return log(a, json);
  if (a._[0] === "earnings") return earnings(a, json);
  const rawYear = a._[0];
  if (rawYear !== undefined && !/^\d{4}$/.test(rawYear)) throw new Error(`expected a YEAR like 2026, got "${rawYear}" — ${USAGE}`);
  if (a._.length > 1) throw new Error(USAGE);
  for (const f of ["month", "hours", "amount", "paid", "txn"]) if (a.flags[f] !== undefined) throw new Error(`--${f} only applies to fin income log`);
  if (RANGE_FLAGS.some((f) => a.flags[f] !== undefined)) return range(a, json, rawYear);
  const year = rawYear ? Number(rawYear) : new Date().getFullYear();
  const data = await getIncomeOverview(year, { source: str(a, "source") });
  emit(json, data, () => {
    const t = data.totals;
    const out = [kv([
      [`total ${year}`, money(t.total)],
      ["W-2 (net pay)", money(t.w2)],
      ["self-employment", `${money(t.se)}  (taxable 1099 / Schedule C)`],
      ["nontaxable", money(t.nontaxable)],
      ["hours", t.hours ? `${t.hours}h, ${money(t.avgRateCents ?? 0)}/h average` : "none logged"],
    ])];
    for (const s of data.sources) out.push(printSource(s));
    const months = data.byMonth.filter((m) => data.sources.some((s) => m[s.source.name]));
    if (months.length) {
      out.push(heading("by month paid"));
      out.push(table([{ head: "MONTH" }, ...data.sources.map((s) => ({ head: s.source.name.toUpperCase(), align: "r" as const })), { head: "TOTAL", align: "r" }],
        months.map((m) => [m.month, ...data.sources.map((s) => money(m[s.source.name] as number)), money(data.sources.reduce((sum, s) => sum + (m[s.source.name] as number), 0))])));
    }
    out.push("\n  * nontaxable. Cash basis: income counts in the year it was paid.");
    return out.join("\n");
  });
}

const pctOf = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

function takeHomeLines(t: TakeHome): [string, string][] {
  return [
    ["income", `${money(t.incomeCents)}  (W-2 ${money(t.w2GrossCents)} + 1099 ${money(t.seGrossCents)}${t.nontaxableCents ? ` + nontaxable ${money(t.nontaxableCents)}` : ""})`],
    ["federal income tax", `${money(t.federal.incomeTaxCents)}  (taxable ${money(t.federal.taxableCents)} after ${money(t.federal.standardDeductionCents)} standard${t.federal.qbiDeductionCents ? ` and ${money(t.federal.qbiDeductionCents)} QBI` : ""}${t.pretaxDeferralsCents ? `; ${money(t.pretaxDeferralsCents)} pre-tax 401(k) excluded` : ""}, ${pctOf(t.federal.marginalRate)} bracket)`],
    ["FICA on wages", money(t.fica.totalCents)],
    ["SE tax", `${money(t.seTax.totalCents)}  (on ${money(t.seNetProfitCents)} net profit after ${money(t.seExpensesCents)} expenses)`],
    ["California income tax", `${money(t.california.incomeTaxCents)}  (${pctOf(t.california.marginalRate)} bracket)`],
    ["California SDI", money(t.california.sdiCents)],
    ["total tax", `${money(t.totalTaxCents)}  (${pctOf(t.effectiveRate)} effective, ${pctOf(t.marginalWageRate)} on the next W-2 dollar)`],
    ["you keep", money(t.keepCents)],
  ];
}

/** `fin take-home [YEAR] [--w2-gross X]`: the year after tax — federal, FICA, SE, California — with W-2 gross rebuilt from paychecks. */
export async function takeHome(a: Args, json: boolean) {
  if (a._[0] === "set") return takeHomeSet(a, json);
  for (const f of SET_FLAGS) if (a.flags[f] !== undefined) throw new Error(`--${f} only applies to fin take-home set`);
  const rawYear = a._[0];
  if (rawYear !== undefined && !/^\d{4}$/.test(rawYear)) throw new Error(`expected a YEAR like 2026, got "${rawYear}" — usage: fin take-home [YEAR] [--w2-gross X] | fin take-home set …`);
  if (a._.length > 1) throw new Error("usage: fin take-home [YEAR] [--w2-gross X] | fin take-home set …");
  const gross = str(a, "w2-gross");
  const r = await getTakeHome(rawYear ? Number(rawYear) : 2026, { w2GrossCents: gross === undefined ? undefined : dollars(gross) });
  const x = r.result, w = r.moneyWent, est = r.w2.withheldIsEstimate ? " (estimated)" : "";
  emit(json, r, () => [
    kv([...takeHomeLines(x),
      ["set aside from 1099", `${money(r.setAside.setAsideCents)}  (${pctOf(r.setAside.rate)} of 1099 net — nothing is withheld from it)`],
      ...(x.federalOwedCents == null ? [] : [[`federal owed vs withheld${est}`, `${money(x.federalOwedCents)}  (withheld ${money(x.federalWithheldCents ?? 0)}; negative = refund)`] as [string, string]]),
      ...(x.caOwedCents == null ? [] : [[`California owed vs withheld${est}`, `${money(x.caOwedCents)}  (withheld ${money(x.caWithheldCents ?? 0)})`] as [string, string]]),
    ]),
    heading(`W-2 gross ${money(r.w2.grossCents)} — ${r.w2.basis}`),
    `  ${r.w2.how}`,
    table([{ head: "PAYDAY" }, { head: "NET", align: "r" }, { head: "401K", align: "r" }, { head: "HSA", align: "r" }, { head: "GROSS", align: "r" }, { head: "FED WH", align: "r" }, { head: "CA WH", align: "r" }, { head: "VS SALARY", align: "r" }, { head: "LEGS" }],
      r.payroll.paychecks.map((p) => [p.date, money(p.netCents), p.deferral401kCents ? money(p.deferral401kCents) : "", p.hsaCents ? money(p.hsaCents) : "", money(p.grossCents), money(p.federalCents), money(p.caCents),
        p.residualCents != null ? `${p.residualCents >= 0 ? "+" : ""}${money(p.residualCents)}` : p.incomplete ? "posting" : "", p.legs.map((l) => `#${l.txnId} ${l.kind}${l.share ? ` (${money(l.cents)} of ${money(l.share.totalCents)}, split over ${l.share.paydays} paydays)` : ""}`).join(", ")])),
    `  401(k) going forward: ${pctOf(r.payroll.k401.rate)} of pay (${r.payroll.k401.source}) = ${money(r.payroll.k401.perCheckCents)} a check${r.payroll.k401.postingCents ? `; ${money(r.payroll.k401.postingCents)} assumed for the check still posting` : ""}`,
    r.payroll.remainingPaydays.length ? `  projected: ${r.payroll.remainingPaydays.length} more at ${money(r.payroll.perCheckCents)} (${r.payroll.remainingPaydays.join(", ")})` : "",
    r.notPaycheck.length ? `  not from a paycheck: ${r.notPaycheck.map((n) => `#${n.txnId} ${money(n.cents)} (${n.why})`).join("; ")}` : "",
    heading("where 2026 money went"),
    kv([
      ["Roth IRA (current year)", `${money(w.rothIra.cents)} of ${money(w.rothIra.limitCents)} — ${money(w.rothIra.roomCents)} room${w.rothIra.priorYearCents ? `; plus ${money(w.rothIra.priorYearCents)} for the prior year` : ""}`],
      ["401(k)", `${money(w.k401.cents)} of ${money(w.k401.limitCents)} — ${money(w.k401.roomCents)} room`],
      ["HSA", `${money(w.hsa.cents)} of ${money(w.hsa.limitCents)} self-only — ${money(w.hsa.roomCents)} room`],
      ["SEP IRA room", money(w.sepRoomCents)],
      ["taxes (estimated)", money(w.taxCents)],
      ["paychecks to bank accounts", money(w.cashToBanksCents)],
      ["1099 pay received", money(w.seCashCents)],
    ]),
    heading(`full year at ${money(r.inputs.annualSalaryCents)} (comparison)`),
    kv([...takeHomeLines(r.fullYear.result), ["set aside from 1099", `${money(r.fullYear.setAside.setAsideCents)}  (${pctOf(r.fullYear.setAside.rate)})`]]),
    ...r.notes.map((n) => `\n  ${n}`),
    `\n  ${r.disclaimer}`,
  ].filter(Boolean).join("\n"));
}

const SET_FLAGS = ["salary", "full-time", "periods", "ca-allowances", "k401", "k401-pct", "hsa-payroll", "project", "ytd-gross", "as-of", "deferrals", "fed-withheld", "ca-withheld", "expected-se"];
const clearable = <T,>(raw: string | undefined, parse: (v: string) => T) => (raw === undefined ? undefined : raw === "none" ? null : parse(raw));
const yesNo = (flag: string) => (v: string) => { if (v === "yes" || v === "true") return true; if (v === "no" || v === "false") return false; throw new Error(`--${flag} expects yes or no, got "${v}"`); };
const int = (flag: string, max: number) => (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`--${flag} expects a whole number 0-${max}, got "${v}"`); return n; };

/** `fin take-home set …`: every assumption behind the estimate; "none" clears a nullable one. */
async function takeHomeSet(a: Args, json: boolean) {
  if (a._.length > 1) throw new Error(`usage: fin take-home set ${SET_FLAGS.map((f) => `[--${f} …]`).join(" ")}`);
  if (a.flags["w2-gross"] !== undefined) throw new Error("--w2-gross is a one-run override; to save a pay stub use --ytd-gross X --as-of YYYY-MM-DD");
  const day = (v: string) => isoDay(v, "--full-time/--as-of");
  const k401 = str(a, "k401");
  if (k401 !== undefined && k401 !== "pretax" && k401 !== "roth") throw new Error(`--k401 expects pretax or roth, got "${k401}"`);
  const patch = Object.fromEntries(Object.entries({
    annualSalaryCents: clearable(str(a, "salary"), dollars),
    fullTimeStart: clearable(str(a, "full-time"), day),
    periods: clearable(str(a, "periods"), int("periods", 52)),
    caAllowances: clearable(str(a, "ca-allowances"), int("ca-allowances", 20)),
    k401Type: k401,
    k401Pct: clearable(str(a, "k401-pct"), (v) => { const n = Number(v.replace(/%$/, "")); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`--k401-pct expects 0-100, got "${v}"`); return n; }),
    hsaPayroll: clearable(str(a, "hsa-payroll"), yesNo("hsa-payroll")),
    projectRest: clearable(str(a, "project"), yesNo("project")),
    ytdGrossCents: clearable(str(a, "ytd-gross"), dollars),
    ytdAsOf: clearable(str(a, "as-of"), day),
    pretaxDeferralsCents: clearable(str(a, "deferrals"), dollars),
    federalWithheldCents: clearable(str(a, "fed-withheld"), dollars),
    caWithheldCents: clearable(str(a, "ca-withheld"), dollars),
    expectedSeCents: clearable(str(a, "expected-se"), dollars),
  }).filter(([, v]) => v !== undefined));
  const saved = await saveTakeHomeInputs(patch);
  emit(json, saved, () => kv(Object.entries(saved).map(([k, v]) => [k, v == null ? "—" : String(v)])));
}
