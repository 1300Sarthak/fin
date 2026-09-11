import { NextResponse } from "next/server";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function PATCH(req: Request) {
  try {
    const { id, isActive, sortOrder } = (await req.json()) as {
      id?: number;
      isActive?: boolean;
      sortOrder?: number;
    };
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    const set: { isActive?: boolean; sortOrder?: number } = {};
    if (typeof isActive === "boolean") set.isActive = isActive;
    if (typeof sortOrder === "number") set.sortOrder = sortOrder;
    if (Object.keys(set).length === 0) {
      return NextResponse.json({ ok: false, error: "nothing to update" }, { status: 400 });
    }
    await db.update(accounts).set(set).where(eq(accounts.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to update account";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
