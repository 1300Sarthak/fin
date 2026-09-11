import { NextResponse } from "next/server";
import { setManualCategory } from "@/lib/categorize";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { id, categoryId } = (await req.json()) as {
      id?: number;
      categoryId?: number | null;
    };
    if (!id || categoryId === undefined || (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0))) {
      return NextResponse.json(
        { ok: false, error: "id and a valid categoryId (or null) are required" },
        { status: 400 },
      );
    }
    await setManualCategory(Number(id), categoryId === null ? null : Number(categoryId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to set category";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
