/**
 * `fin goals` — the /goals page in the terminal: progress by how each goal is
 * measured (balance, Roth/HSA contributions, 401(k) deferrals, entered), the
 * year it counts for, its deadline and sources; plus `set` and `rm`.
 */
import { pick, rowId, str, type Args } from "../args";
import { clip, emit, heading, kv, money, pct, table } from "../render";
import { getGoalsTree, getGoalsWithCurrent, getMonthlyFreeCashFlow, getDebtSnowball, type GoalNode } from "@/lib/planner";
import { createGoal, deleteGoal, findGoalByName, updateGoal, type GoalInput } from "@/lib/goals";
import { PROGRESS_KINDS, PROGRESS_KIND_LABEL, type ProgressKind } from "@/lib/goals-core";

const USAGE = "usage: fin goals set NAME --target X [--kind roth_ira|hsa|k401|manual|balance] [--year Y] [--progress X|none] [--account ID|none] · fin goals rm NAME";

/** "500", "$1,200.50", "0" → cents. Anything else is an error, never zero. */
function dollars(raw: string, flag: string): number {
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error(`--${flag} expects a dollar amount like 7500 or 692.88, got "${raw}"`);
  return Math.round(Number(v) * 100);
}

const measure = (n: GoalNode) => (n.progressKind === "balance" ? "balance" : `${n.progressKind} ${n.taxYear ?? "?"}`);

async function set(a: Args, rest: string[], json: boolean) {
  const [name, ...extra] = rest;
  if (!name?.trim()) throw new Error(USAGE);
  if (extra.length) throw new Error(`unexpected "${extra.join(" ")}" — quote names with spaces`);
  const existing = await findGoalByName(name);
  const target = str(a, "target");
  if (!existing && target === undefined) throw new Error(`no goal named "${name}" yet — give --target to create it`);
  const kind = pick(a, "kind", PROGRESS_KINDS) as ProgressKind | undefined;
  const yearRaw = str(a, "year");
  const progress = str(a, "progress");
  const account = str(a, "account");
  const patch: Partial<GoalInput> = {};
  if (target !== undefined) patch.targetCents = dollars(target, "target");
  if (kind) patch.progressKind = kind;
  if (yearRaw !== undefined) patch.taxYear = yearRaw === "none" ? null : rowId(yearRaw, "a tax year like 2026");
  if (progress !== undefined) patch.manualProgressCents = progress === "none" ? null : dollars(progress, "progress");
  if (account !== undefined) patch.accountIds = account === "none" ? [] : [rowId(account, "an account id")];
  const finalKind = kind ?? existing?.progressKind ?? "balance";
  if (patch.manualProgressCents != null && finalKind !== "manual") throw new Error(`--progress is only for goals measured manually; "${name}" is measured by ${PROGRESS_KIND_LABEL[finalKind]} (add --kind manual)`);
  if (patch.accountIds?.length && finalKind !== "balance") throw new Error(`--account links a balance goal; "${name}" is measured by ${PROGRESS_KIND_LABEL[finalKind]}`);
  if (!Object.keys(patch).length) throw new Error(`nothing to change — ${USAGE}`);

  let id: number;
  if (existing) { id = existing.id; await updateGoal(id, patch); }
  else id = await createGoal({ name: name.trim(), ...patch });
  const tree = await getGoalsTree();
  const node = tree.flatMap((g) => [g, ...g.children]).find((n) => n.id === id);
  return emit(json, { id, created: !existing, goal: node ?? null }, () =>
    `  ${existing ? "updated" : "added"} goal #${id} ${name.trim()}${node ? ` — ${money(node.currentCents)} of ${money(node.targetCents)} (${PROGRESS_KIND_LABEL[node.progressKind]}${node.taxYear ? `, ${node.taxYear}` : ""})` : ""}`);
}

export async function goals(a: Args, json: boolean) {
  const [verb, ...rest] = a._;
  if (verb === "set") return set(a, rest, json);
  if (verb === "rm") {
    if (!rest[0] || rest.length > 1) throw new Error("usage: fin goals rm NAME (quote names with spaces)");
    const g = await findGoalByName(rest[0]);
    if (!g) throw new Error(`no goal named "${rest[0]}" — run fin goals for the names`);
    await deleteGoal(g.id);
    return emit(json, { removed: g.name, id: g.id }, () => `  removed goal #${g.id} ${g.name}`);
  }
  if (verb !== undefined) throw new Error(`unknown goals action "${verb}" — ${USAGE}`);
  if (Object.keys(a.flags).some((k) => k !== "json")) throw new Error(`--target, --kind, --year, --progress and --account go with \`set\` — ${USAGE}`);

  const [tree, fcf, debts, plan] = await Promise.all([getGoalsTree(), getMonthlyFreeCashFlow(), getDebtSnowball(), getGoalsWithCurrent()]);
  emit(json, { goals: tree, freeCashFlow: fcf, debts, plan }, () => {
    const nodes = tree.flatMap((g) => [g, ...g.children]);
    const details = nodes.filter((n) => n.progress).flatMap((n) => {
      const p = n.progress!;
      const lines = [`  ${n.name}`, `    progress  ${p.source}`];
      if (p.limit) lines.push(`    limit     ${money(p.limit.cents)} ${p.limit.status} — ${p.limit.source.title}`);
      if (p.deadline) lines.push(`    deadline  ${p.deadline}${p.window && p.window !== "open" ? ` (${p.window})` : ""}`);
      if (p.projectedCents != null) lines.push(`    projected ${money(p.projectedCents)} more through Dec 31 (not counted above)`);
      if (p.k401) lines.push(`    to max    ${p.k401.message}`);
      if (p.studentLoan) {
        const s = p.studentLoan;
        lines.push(`    interest  ${money(s.interestPaidCents)} entered, ${money(s.deductionCents)} deductible${s.taxSavedCents != null ? `, saves ${money(s.taxSavedCents)} tax` : ""}${s.fullCapSavesCents != null ? `; the full cap would save ${money(s.fullCapSavesCents)}${s.marginalRate != null ? ` (~${pct(s.marginalRate * 100, 0)} federal + CA)` : ""}` : ""}`);
        for (const r of s.paymentsFound) lines.push(`    found     #${r.txnId} ${r.date} ${money(-r.amountCents)} to ${r.merchant} from ${r.account}${r.category ? ` (${r.category})` : ""} — not counted as interest`);
      }
      for (const note of p.notes) lines.push(`    note      ${note}`);
      for (const s of p.sources) lines.push(`    source    ${s.title} ${s.url}`);
      return lines;
    });
    return [
      kv([["Free cash flow", `${money(fcf.estimateCents)} / month (over ${fcf.lookbackMonths} months)`]]),
      heading("Goals"),
      table(
        [{ head: "GOAL" }, { head: "MEASURE" }, { head: "NOW", align: "r" }, { head: "TARGET", align: "r" }, { head: "DONE", align: "r" }, { head: "LEFT", align: "r" }, { head: "DEADLINE" }],
        tree.flatMap((g) =>
          [g, ...g.children].map((n, i) => [
            (i ? "  " : "") + clip(n.name, 30),
            measure(n),
            money(n.currentCents),
            money(n.targetCents),
            n.targetCents ? pct((n.currentCents / n.targetCents) * 100, 0) : "—",
            money(Math.max(0, n.targetCents - n.currentCents)),
            n.progress?.deadline ?? "—",
          ]),
        ),
      ),
      ...(details.length ? [heading("How each tax-year goal is measured"), details.join("\n")] : []),
      ...(plan.left.length ? [heading("Left out of the contribution plan"), plan.left.map((l) => `  ${l.name} — ${l.why}`).join("\n")] : []),
      ...(debts.length
        ? [heading("Debts, smallest first"), table([{ head: "NAME" }, { head: "BALANCE", align: "r" }], debts.map((d) => [clip(d.name, 30), money(d.balanceCents)]))]
        : []),
    ].join("\n");
  });
}
