import Papa from "papaparse";
import { toCents } from "@/lib/format";
import { normalizePayee } from "@/lib/normalize";
import type { NormalizedTransaction } from "./adapter";

/** Stable id from row content (FNV-1a) so re-importing the same file dedupes. */
function hashId(parts: string[]): string {
  let h = 2166136261;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "csv_" + (h >>> 0).toString(36);
}

function pick(row: Record<string, string>, names: string[]): string | undefined {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((k) => k.toLowerCase().trim() === n);
    if (k && row[k] !== "" && row[k] != null) return row[k];
  }
  return undefined;
}

const num = (s: string) => Number.parseFloat(String(s).replace(/[$,\s]/g, ""));

/**
 * Parse a bank/card CSV export into normalized transactions. Handles the two
 * common layouts: a single signed "Amount" column, or separate Debit/Credit
 * columns. Convention: negative = outflow. Use `flipSigns` for exports (e.g.
 * some credit cards) that report purchases as positive.
 */
export function parseCsvTransactions(
  text: string,
  opts: { flipSigns?: boolean } = {},
): { transactions: NormalizedTransaction[]; skipped: number } {
  const { data } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const txns: NormalizedTransaction[] = [];
  let skipped = 0;

  for (const row of data) {
    const dateStr = pick(row, [
      "date",
      "posted date",
      "posting date",
      "transaction date",
      "trans date",
      "post date",
    ]);
    const desc =
      pick(row, [
        "description",
        "payee",
        "name",
        "merchant",
        "details",
        "memo",
      ]) ?? "";

    const amountStr = pick(row, ["amount", "amt"]);
    const debit = pick(row, ["debit", "withdrawal", "withdrawals"]);
    const credit = pick(row, ["credit", "deposit", "deposits"]);

    let amount: number | undefined;
    if (amountStr != null) amount = num(amountStr);
    else if (debit != null || credit != null) {
      const d = debit ? num(debit) : 0;
      const c = credit ? num(credit) : 0;
      amount = (c || 0) - Math.abs(d || 0);
    }

    const date = dateStr ? new Date(dateStr) : null;
    if (!date || Number.isNaN(date.getTime()) || amount == null || Number.isNaN(amount)) {
      skipped++;
      continue;
    }
    if (opts.flipSigns) amount = -amount;

    const merchantRaw = String(desc).trim() || "(no description)";
    txns.push({
      externalId: hashId([
        date.toISOString().slice(0, 10),
        amount.toFixed(2),
        merchantRaw,
      ]),
      postedAt: date,
      amountCents: toCents(amount),
      merchantRaw,
      payeeNormalized: normalizePayee(merchantRaw),
      memo: null,
      isPending: false,
    });
  }

  return { transactions: txns, skipped };
}
