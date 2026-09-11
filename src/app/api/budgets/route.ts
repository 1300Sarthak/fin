import { NextResponse } from "next/server";
import { db } from "@/db";
import { budgets } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { categoryId, limitCents } = (await req.json()) as {
      categoryId?: number;
      limitCents?: number;
    };
    if (!categoryId || !limitCents || limitCents <= 0) {
      return NextResponse.json(
        { ok: false, error: "categoryId and a positive limit are required" },
        { status: 400 },
      );
    }
    await db
      .insert(budgets)
      .values({ categoryId, period: "monthly", limitCents })
      .onConflictDoUpdate({
        target: [budgets.categoryId, budgets.period],
        set: { limitCents },
      });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to save budget";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!id) {
      return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    }
    await db.delete(budgets).where(eq(budgets.id, id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to delete budget";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
