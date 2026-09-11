/**
 * Corrections. Reading the ledger is most of the job, but every session that
 * reads it eventually finds a row that is wrong — a merchant the categoriser
 * guessed badly, a pending hold that already settled, money that was never
 * yours. These are the primitives for fixing those in place.
 */
import { bool, num, RANGE, rowId, type Args } from "../args";
import { clip, emit, heading, kv, money, table } from "../render";
import { setManualCategory } from "@/lib/categorize";
import { getCategoriesForSelect } from "@/lib/queries";
import { setExcluded, findPendingDuplicates, listPending } from "@/lib/ledger";
import { setRefund } from "@/lib/refunds";
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
  await setManualCategory(id, hits[0].id);
  emit(json, { id, category: hits[0].name }, () => `  ${what}\n  → ${hits[0].name} (remembered for this merchant)`);
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
