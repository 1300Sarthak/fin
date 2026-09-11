import { NextResponse } from "next/server";
import { parseCsvTransactions } from "@/lib/ingest/csv";
import { ingestCsvTransactions } from "@/lib/ingest/adapter";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const accountId = Number(form.get("accountId"));
    const flipSigns = form.get("flipSigns") === "true";

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file uploaded" }, { status: 400 });
    }
    if (!accountId) {
      return NextResponse.json({ ok: false, error: "Choose an account" }, { status: 400 });
    }

    const text = await file.text();
    const { transactions, skipped } = parseCsvTransactions(text, { flipSigns });
    if (transactions.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No valid rows found — check the CSV has Date and Amount columns." },
        { status: 400 },
      );
    }

    const { inserted, updated } = await ingestCsvTransactions(accountId, transactions);
    const extra = skipped ? `, ${skipped} skipped` : "";
    return NextResponse.json({
      ok: true,
      message: `Imported ${inserted} new, ${updated} updated${extra}`,
      inserted,
      updated,
      skipped,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Import failed";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
