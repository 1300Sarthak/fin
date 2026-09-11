import { NextResponse } from "next/server";
import { db } from "@/db";
import { transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { id, note } = (await req.json()) as { id?: number; note?: string };
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    // Empty note clears it (null) so the AI re-categorizer ignores it.
    await db
      .update(transactions)
      .set({ note: note?.trim() ? note.trim() : null })
      .where(eq(transactions.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to save note";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
