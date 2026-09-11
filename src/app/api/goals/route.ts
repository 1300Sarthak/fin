import { NextResponse } from "next/server";
import { createGoal, updateGoal, deleteGoal, type GoalInput } from "@/lib/goals";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GoalInput;
    const id = await createGoal(body);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to create goal";
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { id, ...rest } = (await req.json()) as { id?: number } & Partial<GoalInput>;
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    await updateGoal(Number(id), rest);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to update goal";
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    await deleteGoal(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to delete goal";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
