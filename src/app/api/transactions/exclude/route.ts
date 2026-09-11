import { NextResponse } from "next/server";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

/** Keep a ledger entry visible while excluding it from every cash-flow metric. */
export async function POST(req: Request) {
  try {
    const { id, isExcluded } = (await req.json()) as {
      id?: number;
      isExcluded?: boolean;
    };
    if (!id || typeof isExcluded !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "id and isExcluded are required" },
        { status: 400 },
      );
    }
    const existing = await db
      .select({ id: transactions.id, isTransfer: transactions.isTransfer })
      .from(transactions)
      .where(eq(transactions.id, id))
      .get();
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Transaction not found" }, { status: 404 });
    }
    if (isExcluded && existing.isTransfer) {
      return NextResponse.json(
        { ok: false, error: "A transfer is already excluded from cash flow. Restore it before using Never count." },
        { status: 409 },
      );
    }
    await db
      .update(transactions)
      .set({ isExcluded })
      .where(eq(transactions.id, id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Failed to update transaction" },
      { status: 500 },
    );
  }
}
