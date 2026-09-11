/**
 * Forward-looking commands: what is due, what recurs, what the goals need, and
 * what looks off.
 */
import { bool, isoDay, num, RANGE, rowId, str, type Args } from "../args";
import { clip, emit, heading, kv, money, pct, table } from "../render";
import { getUpcomingBills, getBalanceForecast, getLowBalanceWarning } from "@/lib/forecast";
import { getRecurringSeries } from "@/lib/recurring";
import { getEndingTrials } from "@/lib/trials";
import { getCancellationReminders, createCancellationReminder, setCancellationReminderStatus } from "@/lib/cancellation-reminders";
import { getGoalsTree, getMonthlyFreeCashFlow, getDebtSnowball } from "@/lib/planner";
import { getSpendingAnomalies } from "@/lib/anomalies";
import { getAccountsWithInstitution } from "@/lib/queries";

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function upcoming(a: Args, json: boolean) {
  const days = num(a, "days", RANGE.days) ?? 30;
  const [bills, forecast, warning] = await Promise.all([
    getUpcomingBills(days),
    getBalanceForecast(days),
    getLowBalanceWarning(),
  ]);
  // With no spendable account on file the forecast is a flat line of zeroes,
  // and a "dips to $0.00" warning drawn from it is a fabrication.
  const accounts = await countSpendableAccounts();
  emit(json, { bills, forecast, warning, hasAccounts: accounts > 0 }, () => {
    if (!accounts) {
      return "No spendable accounts on file, so there is no balance to forecast.\nRun `fin sync`, or add cash with `fin cash set 200`.";
    }
    return [
      kv([
        ["Spendable now", money(forecast.points[0]?.balanceCents ?? 0)],
        [`In ${days} days`, money(forecast.points.at(-1)?.balanceCents ?? 0)],
        ...(warning.triggered && warning.date
          ? ([["Low-balance warning", `${warning.date} (${warning.daysAway}d) dips to ${money(warning.balanceCents)}`]] as [string, string][])
          : []),
      ]),
      heading(`Bills due in the next ${days} days`),
      table(
        [{ head: "DUE" }, { head: "IN", align: "r" }, { head: "NAME" }, { head: "AMOUNT", align: "r" }, { head: "STATUS" }],
        bills.map((b) => [day(b.dueAt), `${b.daysAway}d`, clip(b.name, 28), money(b.amountCents), b.isLate ? "late" : b.status]),
      ),
    ].join("\n");
  });
}

/** Does the forecast have anything to forecast from? */
async function countSpendableAccounts(): Promise<number> {
  const rows = await getAccountsWithInstitution();
  return rows.filter((r) => r.isAsset && r.isActive).length;
}

export async function recurring(_a: Args, json: boolean) {
  const [series, trials] = await Promise.all([getRecurringSeries(), getEndingTrials()]);
  const monthlyCents = series
    .filter((s) => s.status !== "missed")
    .reduce((sum, s) => sum + s.expectedAmountCents * ({ weekly: 4.33, biweekly: 2.17, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[s.cadence] ?? 1), 0);
  emit(json, { series, trials }, () =>
    [
      kv([["Recurring load", `${money(Math.round(monthlyCents))} / month across ${series.length} series`]]),
      heading("Series"),
      table(
        [{ head: "ID", align: "r" }, { head: "NAME" }, { head: "CADENCE" }, { head: "EXPECTED", align: "r" }, { head: "LAST", align: "r" }, { head: "NEXT" }, { head: "STATUS" }],
        series.map((s) => [s.id, clip(s.name, 26), s.cadence, money(s.expectedAmountCents), money(s.lastAmountCents), s.nextExpectedAt ? day(s.nextExpectedAt) : "—", s.status]),
      ),
      ...(trials.length
        ? [
            heading("Trials ending"),
            table(
              [{ head: "NAME" }, { head: "ENDS" }, { head: "THEN", align: "r" }],
              trials.map((t) => [clip(t.name, 26), day(t.endedAt), money(t.fullAmountCents)]),
            ),
          ]
        : []),
    ].join("\n"),
  );
}

export async function reminders(a: Args, json: boolean) {
  const [verb, ...rest] = a._;
  if (verb === "add") {
    // The trailing token is the due date only if it reads as one. Popping it
    // unconditionally turned "no date given" into "no name given".
    const flagDate = str(a, "date");
    const trailing = rest.at(-1);
    const trailingIsDate = trailing !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(trailing);
    if (!flagDate && trailingIsDate) rest.pop();
    const name = rest.join(" ").trim();
    if (!name) throw new Error('usage: fin reminders add NAME YYYY-MM-DD   (e.g. fin reminders add "cancel gym" 2026-10-01)');
    if (!flagDate && !trailingIsDate) {
      throw new Error(`"${name}" has no due date — end the command with YYYY-MM-DD, or pass --date YYYY-MM-DD`);
    }
    const dueDate = isoDay(flagDate ?? trailing!, "the due date");
    const r = await createCancellationReminder({ name, dueDate, note: str(a, "note") });
    return emit(json, r, () => `  ${r.created ? "added" : "already had"} reminder #${r.reminder.id} — ${r.reminder.name} due ${r.reminder.dueDate}`);
  }
  if (verb === "done") {
    const id = rowId(rest[0], "a reminder id");
    const existing = await getCancellationReminders({ includeCompleted: true });
    if (!existing.some((r) => r.id === id)) {
      throw new Error(`no reminder #${id} — run fin reminders --all for the ids that exist`);
    }
    await setCancellationReminderStatus(id, "completed");
    return emit(json, { id }, () => `  reminder #${id} completed`);
  }
  if (verb !== undefined && verb !== "list") {
    throw new Error(`Unknown verb "${verb}" — usage: fin reminders [list|add NAME YYYY-MM-DD|done ID] [--all]`);
  }
  const rows = await getCancellationReminders({ includeCompleted: bool(a, "all") });
  emit(json, rows, () =>
    table(
      [{ head: "ID", align: "r" }, { head: "DUE" }, { head: "NAME" }, { head: "STATUS" }, { head: "NOTE" }],
      rows.map((r) => [r.id, r.dueDate, clip(r.name, 28), r.status, clip(r.note ?? "", 30)]),
    ),
  );
}

export async function goals(_a: Args, json: boolean) {
  const [tree, fcf, debts] = await Promise.all([getGoalsTree(), getMonthlyFreeCashFlow(), getDebtSnowball()]);
  emit(json, { goals: tree, freeCashFlow: fcf, debts }, () =>
    [
      kv([["Free cash flow", `${money(fcf.estimateCents)} / month (over ${fcf.lookbackMonths} months)`]]),
      heading("Goals"),
      table(
        [{ head: "GOAL" }, { head: "NOW", align: "r" }, { head: "TARGET", align: "r" }, { head: "DONE", align: "r" }, { head: "LEFT", align: "r" }],
        tree.flatMap((g) =>
          [g, ...g.children].map((n, i) => [
            (i ? "  " : "") + clip(n.name, 30),
            money(n.currentCents),
            money(n.targetCents),
            n.targetCents ? pct((n.currentCents / n.targetCents) * 100, 0) : "—",
            money(Math.max(0, n.targetCents - n.currentCents)),
          ]),
        ),
      ),
      ...(debts.length
        ? [
            heading("Debts, smallest first"),
            table([{ head: "NAME" }, { head: "BALANCE", align: "r" }], debts.map((d) => [clip(d.name, 30), money(d.balanceCents)])),
          ]
        : []),
    ].join("\n"),
  );
}

export async function anomalies(a: Args, json: boolean) {
  const rows = await getSpendingAnomalies(str(a, "month") ?? a._[0]);
  emit(json, rows, () =>
    table(
      [{ head: "SEVERITY" }, { head: "KIND" }, { head: "WHAT" }],
      rows.map((x) => [x.severity, x.kind, clip(`${x.title} — ${x.detail}`, 88)]),
    ),
  );
}

