/**
 * Spending, budget groups, and the daily allowance: the CLI twin of /spending.
 * Every number comes from the same lib calls the page makes.
 */
import { bool, isoDay, month, num, pick, RANGE, str, type Args } from "../args";
import { clip, emit, heading, kv, money, pct, signed, table } from "../render";
import { RANGE_PRESETS, presetRange } from "@/components/kit/range";
import { getSpendingByAccount, getSpendingByCategory, getTopMerchants, monthRange } from "@/lib/spending";
import { concreteRange, daySpan, getCashflowBuckets, getSpendingSummary } from "@/lib/spending-summary";
import {
  categoryIdsByName,
  getBudgetGroupsReport,
  removeBudgetGroup,
  saveBudgetGroup,
  paceLabel,
  type BudgetGroupReport,
} from "@/lib/budget-groups";
import { getAllowance } from "@/lib/allowance";
import { pacificCalendarDate } from "@/lib/calendar";
import { isValid, parseISO } from "date-fns";

/** YYYY-MM, defaulting to the Pacific calendar like the page and the allowance (args.month uses UTC). */
const monthOr = (v: string | undefined) => month(v ?? pacificCalendarDate().slice(0, 7));

/** A real calendar day: 2026-02-31 is refused with the flag's name rather than "Invalid time value". */
function realDay(v: string, label: string) {
  const d = isoDay(v, label);
  if (!isValid(parseISO(d)) || parseISO(d).getDate() !== Number(d.slice(8))) throw new Error(`${label} ${d} is not a real date`);
  return d;
}

/** Positionals beyond what a command reads are typos, not something to ignore. */
function noExtra(extra: string[], usage: string) {
  if (extra.length) throw new Error(`unexpected "${extra.join(" ")}" — usage: ${usage}`);
}

const PERIODS = RANGE_PRESETS.map((p) => p.value);

/** `fin spending 2026-08`, `--month`, `--period ytd`, or `--from D --to D`; default this month. */
async function rangeFrom(a: Args) {
  const from = str(a, "from");
  const to = str(a, "to");
  const period = pick(a, "period", PERIODS);
  const [pos, ...extra] = a._;
  noExtra(extra, "fin spending [YYYY-MM] [--period P | --from D --to D] [--by …]");
  if (pos && str(a, "month")) throw new Error("give the month once, either as YYYY-MM or --month");
  const m = str(a, "month") ?? (pos === undefined ? undefined : month(pos));
  const given = [from || to ? "--from/--to" : null, period ? "--period" : null, m ? "a month" : null].filter(Boolean);
  if (given.length > 1) throw new Error(`give one of a month, --period, or --from/--to — got ${given.join(" and ")}`);
  if (from || to) {
    if (!from || !to) throw new Error("--from and --to go together");
    const [f, t] = [realDay(from, "--from"), realDay(to, "--to")].sort();
    return { from: f, to: t, label: `${f} to ${t}` };
  }
  if (m) {
    const r = monthRange(month(m));
    return { from: `${r.key}-01`, to: `${r.key}-${String(r.end.getDate()).padStart(2, "0")}`, label: r.label };
  }
  const p = presetRange(period ?? "this-month");
  return { from: p.from, to: p.to, label: p.label };
}

const vs = (now: number, before: number) => {
  const d = now - before;
  return `${d > 0 ? "+" : d < 0 ? "-" : ""}${money(Math.abs(d))}`;
};

export async function spending(a: Args, json: boolean) {
  const range = await rangeFrom(a);
  const { from, to } = await concreteRange(range.from, range.to);
  const span = daySpan(from, to);
  const by = pick(a, "by", ["category", "merchant", "card", "account", "month"] as const) ?? "category";
  const limit = num(a, "limit", RANGE.limit) ?? 15;

  if (by === "merchant") {
    const rows = await getTopMerchants(span, limit);
    return emit(json, rows, () =>
      table(
        [{ head: "MERCHANT" }, { head: "SPENT", align: "r" }, { head: "N", align: "r" }],
        rows.map((x) => [clip(x.merchant, 34), money(x.spentCents), x.count]),
      ),
    );
  }
  if (by === "card" || by === "account") {
    const rows = await getSpendingByAccount(span);
    return emit(json, rows, () =>
      table(
        [{ head: "ID", align: "r" }, { head: "ACCOUNT" }, { head: "SPENT", align: "r" }, { head: "REFUNDED", align: "r" }, { head: "N", align: "r" }],
        rows.map((x) => [x.accountId, clip(x.name, 34), money(x.spentCents), money(x.refundedCents), x.count]),
      ),
    );
  }
  if (by === "month") {
    const rows = await getCashflowBuckets(from, to);
    return emit(json, rows, () =>
      table(
        [{ head: "MONTH" }, { head: "MADE", align: "r" }, { head: "SPENT", align: "r" }, { head: "NET", align: "r" }],
        rows.map((x) => [`${x.month}${x.inRange ? "" : " ·"}`, money(x.income), money(x.expense), signed(x.income - x.expense)]),
      ) + (rows.some((x) => !x.inRange) ? "\n  · outside the range, shown for context" : ""),
    );
  }

  const [summary, rows] = await Promise.all([getSpendingSummary({ from: range.from, to: range.to }), getSpendingByCategory(span)]);
  const s = summary;
  const p = s.previous;
  emit(json, { range: { from, to, label: range.label }, cashflow: s.cashflow, summary: s, categories: rows }, () =>
    [
      heading(`${range.label} (${from} to ${to})`).trimStart(),
      kv([
        ["Made", money(s.cashflow.incomeCents)],
        ["Spent", `${money(s.cashflow.spendingCents)}${p ? `  (${vs(s.cashflow.spendingCents, p.cashflow.spendingCents)} vs ${p.from} to ${p.to})` : ""}`],
        ["Net", signed(s.cashflow.net)],
        ["Burn rate", `${pct(s.burn.burnPct)} of take-home ${money(s.burn.takeHomeCents)}  (fin burn)${p ? `, was ${pct(p.burnPct)}` : ""}`],
        ["Daily average", `${money(s.dailyAvgCents)} over ${s.days} day${s.days === 1 ? "" : "s"}`],
        ...(s.projectedMonthEndCents != null ? [["Projected month end", money(s.projectedMonthEndCents)] as [string, string]] : []),
      ]),
      heading("By category"),
      table(
        [{ head: "CATEGORY" }, { head: "SPENT", align: "r" }, { head: "SHARE", align: "r" }, { head: "N", align: "r" }],
        rows.slice(0, limit).map((x) => [clip(x.name, 28), money(x.spentCents), pct(x.pct * 100), x.count]),
      ),
    ].join("\n"),
  );
}

/* --------------------------------- budgets ---------------------------------- */

/** "500", "500.5", "$1,200" → cents. Anything else is an error, never zero. */
function dollars(raw: string | undefined): number {
  const v = (raw ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v) || Number(v) <= 0) {
    throw new Error(`expected a positive dollar amount, got "${raw ?? ""}" — usage: fin budgets set "Food" 500 --categories "Food & Dining,Groceries"`);
  }
  return Math.round(Number(v) * 100);
}

const groupLine = (g: BudgetGroupReport) => [
  clip(g.name, 22),
  money(g.spentCents),
  money(g.limitCents),
  g.remainingCents < 0 ? `over ${money(-g.remainingCents)}` : money(g.remainingCents),
  g.perDayRemainingCents == null ? "-" : money(g.perDayRemainingCents),
  g.status === "over" ? signed(g.paceDeltaCents) : paceLabel(g, money),
  money(g.projectedCents),
  g.status,
];

export async function budgets(a: Args, json: boolean) {
  const [verb, ...rest] = a._;

  if (verb === "set") {
    const [name, amount, ...extra] = rest;
    if (!name) throw new Error('usage: fin budgets set NAME AMOUNT [--categories "A,B"] [--catch-all]');
    if (extra.length) throw new Error(`unexpected "${extra.join(" ")}" — quote names with spaces`);
    const cats = str(a, "categories");
    const catchAll = bool(a, "catch-all");
    const group = await saveBudgetGroup({
      name,
      limitCents: dollars(amount),
      catchAll,
      categoryIds: cats ? await categoryIdsByName(cats.split(",").map((c) => c.trim()).filter(Boolean)) : [],
    });
    return emit(json, group, () => `Saved "${group.name}": ${money(group.limitCents)} a month${group.catchAll ? ", everything no other group covers" : ""}.`);
  }
  if (verb === "rm") {
    if (!rest[0] || rest.length > 1) throw new Error("usage: fin budgets rm NAME (quote names with spaces)");
    const removed = await removeBudgetGroup(rest[0]);
    return emit(json, { removed }, () => `Removed "${removed}".`);
  }
  if (verb && verb !== "show" && !/^\d{4}-\d{2}$/.test(verb)) {
    throw new Error(`unknown budgets action "${verb}" — use show, set, or rm`);
  }
  const positional = verb === "show" ? rest : verb ? [verb, ...rest] : [];
  noExtra(positional.slice(1), "fin budgets [show] [YYYY-MM]");
  if (positional[0] && str(a, "month")) throw new Error("give the month once, either as YYYY-MM or --month");
  const m = monthOr(str(a, "month") ?? positional[0]);
  const r = await getBudgetGroupsReport(m);
  emit(json, r, () => {
    const out: string[] = [];
    const c = r.clock;
    out.push(`${r.label}: day ${c.daysElapsed} of ${c.daysInMonth}`);
    if (r.groups.length) {
      out.push(
        table(
          [
            { head: "GROUP" }, { head: "SPENT", align: "r" }, { head: "LIMIT", align: "r" }, { head: "LEFT", align: "r" },
            { head: "PER DAY", align: "r" }, { head: "VS PACE", align: "r" }, { head: "PROJECTED", align: "r" }, { head: "STATUS" },
          ],
          [...r.groups.map(groupLine), ["Total", money(r.total.spentCents), money(r.total.limitCents), r.total.remainingCents < 0 ? `over ${money(-r.total.remainingCents)}` : money(r.total.remainingCents), "", "", "", ""]],
        ),
      );
      for (const g of r.groups) {
        const names = g.categories.map((x) => `${x.name} ${money(x.spentCents)}`).join(", ");
        out.push(`  ${g.name}: ${g.catchAll ? "catch-all" : `${g.categoryIds.length} categories`}${names ? ` — ${names}` : ""}`);
      }
    } else {
      out.push('  No budget groups. Try: fin budgets set "Food" 500 --categories "Food & Dining,Groceries"');
    }
    if (r.legacy.length) {
      out.push(
        heading("Per-category budgets"),
        table(
          [{ head: "CATEGORY" }, { head: "LIMIT", align: "r" }, { head: "SPENT", align: "r" }, { head: "LEFT", align: "r" }],
          r.legacy.map((b) => [clip(b.name, 28), money(b.limitCents), money(b.spentCents), money(b.limitCents - b.spentCents)]),
        ),
      );
    }
    return out.join("\n");
  });
}

/* -------------------------------- allowance --------------------------------- */

export async function allowance(a: Args, json: boolean) {
  noExtra(a._, "fin allowance [--month YYYY-MM]");
  const m = monthOr(str(a, "month"));
  const [r, groups] = await Promise.all([getAllowance(m), getBudgetGroupsReport(m)]);
  emit(json, { ...r, groups: r.budgetSource === "groups" ? groups.groups : [] }, () => {
    if (r.budgetCents == null) {
      return 'No monthly budget set.\nSet one with: fin budgets set "Everything" 650 --catch-all\n(or the older single number: fin config monthly_budget_cents 65000)';
    }
    const lines = [
      heading(`Allowance — ${r.monthKey}`).trimStart(),
      kv([
        ["Budget", `${money(r.budgetCents)}${r.budgetSource === "groups" ? `  (sum of ${groups.groups.length} budget groups)` : ""}`],
        ["Spent", `${money(r.spentCents)}  (day ${r.daysElapsed} of ${r.daysInMonth})`],
        ["Committed bills", money(r.committedCents)],
        ["Free to spend", money(r.freeCents)],
        ["Per day", r.perDayCents == null ? "-" : `${money(r.perDayCents)}  over ${r.daysRemaining} days`],
        ["Current pace", `${money(r.paceCents)}/day → ${money(r.projectedCents)}`],
      ]),
    ];
    if (r.budgetSource === "groups") {
      lines.push(
        heading("By group"),
        kv(groups.groups.map((g) => [
          g.name,
          `${money(g.spentCents)} of ${money(g.limitCents)}${g.perDayRemainingCents == null ? "" : `, ${money(g.perDayRemainingCents)}/day left`}${g.status === "on-track" ? "" : ` (${paceLabel(g, money)})`}`,
        ])),
      );
    }
    if (r.isOver) lines.push(`\nOver budget by ${money(r.spentCents - r.budgetCents)}.`);
    return lines.join("\n");
  });
}
