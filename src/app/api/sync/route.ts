import { NextResponse } from "next/server";
import { syncSimplefin, SyncError } from "@/lib/ingest/sync";
import { detectTransfers } from "@/lib/transfers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const r = await syncSimplefin();
    // Flag internal money movement (card payments, transfers) so spending stays clean.
    await detectTransfers();
    const parts = [`${r.accounts} account${r.accounts === 1 ? "" : "s"}`];
    parts.push(`${r.newTransactions} new txn${r.newTransactions === 1 ? "" : "s"}`);
    if (r.updatedTransactions) parts.push(`${r.updatedTransactions} updated`);
    if (r.newAccounts) parts.push(`${r.newAccounts} new account${r.newAccounts === 1 ? "" : "s"}`);
    if (r.adoptedAccounts) parts.push(`${r.adoptedAccounts} reconnected`);
    return NextResponse.json({
      ok: true,
      message: `Synced ${parts.join(", ")}`,
      ...r,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Sync failed";
    const status = e instanceof SyncError ? 400 : 500;
    return NextResponse.json({ ok: false, error }, { status });
  }
}
