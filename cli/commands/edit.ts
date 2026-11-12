/**
 * Corrections. Reading the ledger is most of the job, but every session that
 * reads it eventually finds a row that is wrong — a merchant the categoriser
 * guessed badly, a pending hold that already settled, money that was never
 * yours. These are the primitives for fixing those in place.
 */
import { bool, month, num, RANGE, rowId, str, type Args } from "../args";
import { clip, emit, heading, kv, money, table } from "../render";
import { setManualCategory } from "@/lib/categorize";
import { getCategoriesForSelect } from "@/lib/queries";
import { setExcluded, findPendingDuplicates, listPending } from "@/lib/ledger";
import { setRefund } from "@/lib/refunds";
import { applyChange, listActivity, listChanges, proposeSplit, undoChange } from "@/lib/assistant/changes";
import { monthRange } from "@/lib/spending";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

const day = (d: Date) => d.toISOString().slice(0, 10);

async function describe(id: number) {
  const t = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      amountCents: transactions.amountCents,
      merchant: transactions.merchantRaw,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get();
  if (!t) throw new Error(`no transaction #${id}`);
  return `#${t.id} ${day(t.postedAt)} ${t.merchant} ${money(t.amountCents)}`;
}

/**
 * Set a category by name. Matching is deliberately forgiving — an agent should
 * not have to look up an id first — but an ambiguous name is reported rather
 * than guessed, because the wrong category silently reshapes every total.
 */
export async function cat(a: Args, json: boolean) {
  const [rawId, ...nameParts] = a._;
  const name = nameParts.join(" ").trim();
  if (!rawId || !name) {
    throw new Error('usage: fin cat <txn-id> <category>   (e.g. fin cat 412 "Public Transit")');
  }
  const id = rowId(rawId, "a transaction id");

  const cats = await getCategoriesForSelect();
  if (name.toLowerCase() === "none") {
    await setManualCategory(id, null);
    return emit(json, { id, category: null }, () => `  cleared category on ${id}`);
  }

  const lower = name.toLowerCase();
  const exact = cats.filter((c) => c.name.toLowerCase() === lower);
  const partial = cats.filter((c) => c.name.toLowerCase().includes(lower));
  const hits = exact.length ? exact : partial;
  if (!hits.length) {
    throw new Error(`no category matching "${name}" — try: ${cats.map((c) => c.name).join(", ")}`);
  }
  if (hits.length > 1) {
    throw new Error(`"${name}" matches ${hits.map((c) => c.name).join(", ")} — be more specific`);
  }

  const what = await describe(id);
  const { remembered } = await setManualCategory(id, hits[0].id);
  // A direction-specific fix (an outflow filed as income, say) deliberately
  // writes no merchant rule, so do not claim it was remembered.
  const note = remembered
    ? "remembered for this merchant"
    : "this row only — a merchant rule would mislabel its other transactions";
  emit(json, { id, category: hits[0].name, remembered }, () => `  ${what}\n  → ${hits[0].name} (${note})`);
}

/** Drop a row from every metric while leaving it visible in the ledger. */
export async function exclude(a: Args, json: boolean) {
  if (!a._[0]) throw new Error("usage: fin exclude <txn-id> [--undo]");
  const id = rowId(a._[0], "a transaction id");
  const undo = bool(a, "undo");
  const what = await describe(id);
  await setExcluded(id, !undo);
  emit(json, { id, isExcluded: !undo }, () => `  ${what}\n  → ${undo ? "counted again" : "excluded from every total"}`);
}

/** Flag a money-in row as a refund, optionally against the purchase it reverses. */
export async function refund(a: Args, json: boolean) {
  if (!a._[0]) throw new Error("usage: fin refund-mark <txn-id> [--reverses <txn-id>] [--undo]");
  const id = rowId(a._[0], "a transaction id");
  const undo = bool(a, "undo");
  const reverses = num(a, "reverses", RANGE.id);
  const what = await describe(id);
  await setRefund(id, !undo, reverses ?? null);
  emit(json, { id, isRefund: !undo, reverses: reverses ?? null }, () =>
    `  ${what}\n  → ${undo ? "no longer a refund" : `refund${reverses ? ` reversing #${reverses}` : ""}`}`,
  );
}

/**
 * Pending holds, and which of them have already settled under a second row.
 * A settled twin means the month is counting one purchase twice.
 */
export async function pending(a: Args, json: boolean) {
  const days = num(a, "days", RANGE.days) ?? 60;
  const since = new Date(Date.now() - days * 86_400_000);
  const [rows, dupes] = await Promise.all([listPending(since), findPendingDuplicates()]);
  const dupeIds = new Set(dupes.map((d) => d.pendingId));
  const held = rows.reduce((s, r) => s + (r.amountCents < 0 ? -r.amountCents : 0), 0);
  const doubled = dupes.reduce((s, d) => s + (d.amountCents < 0 ? -d.amountCents : 0), 0);

  emit(json, { pending: rows, duplicates: dupes }, () =>
    [
      kv([
        [`Pending, last ${days}d`, `${rows.length} rows holding ${money(held)}`],
        ["Already settled twice", dupes.length ? `${dupes.length} rows worth ${money(doubled)}` : "none"],
      ]),
      ...(dupes.length
        ? [
            heading("Counted twice — the pending row is a stale hold"),
            table(
              [{ head: "PENDING", align: "r" }, { head: "DATE" }, { head: "POSTED AS", align: "r" }, { head: "DATE" }, { head: "AMOUNT", align: "r" }, { head: "MERCHANT" }],
              dupes.map((d) => [`#${d.pendingId}`, d.pendingDate, `#${d.postedId}`, d.postedDate, money(d.amountCents), clip(d.merchant, 28)]),
            ),
            `\n  Drop one with: fin exclude ${dupes[0].pendingId}`,
          ]
        : []),
      heading(`All pending`),
      table(
        [{ head: "ID", align: "r" }, { head: "DATE" }, { head: "AMOUNT", align: "r" }, { head: "MERCHANT" }, { head: "ACCOUNT" }, { head: "" }],
        rows.map((r) => [r.id, day(r.postedAt), money(r.amountCents), clip(r.merchant, 30), clip(r.account, 22), dupeIds.has(r.id) ? "settled twin" : ""]),
      ),
    ].join("\n"),
  );
}

/**
 * Count only your share of a purchase others paid back. The same proposal,
 * backup and audit trail as the assistant, applied immediately because running
 * this command is the approval.
 */
export async function split(a: Args, json: boolean) {
  const usage = "usage: fin split <txn-id> <my-share-usd> [--undo]   (e.g. fin split 412 21.00)";
  if (!a._[0]) throw new Error(usage);
  const id = rowId(a._[0], "a transaction id");
  if (bool(a, "undo")) {
    const last = (await listChanges(undefined, ["applied"])).find((c) => c.kind === "split" && c.txn.id === id);
    if (!last) throw new Error(`no applied split on #${id} to undo`);
    const change = await undoChange(last.id);
    return emit(json, change, () => `  #${id} restored: undid change #${change.id}`);
  }
  const raw = a._[1]?.replace(/^\$/, "");
  if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error(usage);
  const proposal = await proposeSplit(id, Math.round(Number(raw) * 100), "cli");
  const change = await applyChange(proposal.id);
  emit(json, change, () => `  change #${change.id}\n  ${change.summary}`);
}

/** The audit log of assistant and CLI edits, newest first. */
export async function changes(a: Args, json: boolean) {
  if (bool(a, "all")) {
    const limit = Number(str(a, "limit") ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be a whole number from 1 to 1000.");
    const rows = await listActivity(limit);
    return emit(json, rows, () => table(
      [{ head: "ID", align: "r" }, { head: "STATUS" }, { head: "WHEN" }, { head: "UNDO" }, { head: "COMMAND" }],
      rows.map((c) => [c.id, c.status, c.at.slice(0, 16).replace("T", " "), c.undoable ? "yes" : "no", clip(c.command, 80)]),
    ));
  }
  const m = month(str(a, "month") ?? a._[0] ?? monthRange().key);
  const rows = await listChanges(m);
  emit(json, rows, () => table(
    [{ head: "ID", align: "r" }, { head: "STATUS" }, { head: "KIND" }, { head: "DATE" }, { head: "AMOUNT", align: "r" }, { head: "SUMMARY" }],
    rows.map((c) => [c.id, c.status, c.kind, c.txn.date, money(c.txn.amountCents), clip(c.summary, 70)]),
  ));
}
