import { NextResponse } from "next/server";
import {
  createCancellationReminder,
  getCancellationReminders,
  setCancellationReminderStatus,
} from "@/lib/cancellation-reminders";

export const runtime = "nodejs";

export async function GET() {
  const reminders = await getCancellationReminders({ includeCompleted: true });
  return NextResponse.json({ ok: true, reminders });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: unknown;
      dueDate?: unknown;
      note?: unknown;
      id?: unknown;
      status?: unknown;
    };

    if (body.id !== undefined || body.status !== undefined) {
      if (typeof body.id !== "number" || (body.status !== "active" && body.status !== "completed")) {
        return NextResponse.json({ ok: false, error: "A valid reminder and status are required." }, { status: 400 });
      }
      const reminder = await setCancellationReminderStatus(body.id, body.status);
      return NextResponse.json({ ok: true, reminder });
    }

    if (typeof body.name !== "string" || typeof body.dueDate !== "string") {
      return NextResponse.json({ ok: false, error: "name and dueDate are required." }, { status: 400 });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return NextResponse.json({ ok: false, error: "note must be text." }, { status: 400 });
    }
    const result = await createCancellationReminder({ name: body.name, dueDate: body.dueDate, note: body.note });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to save reminder";
    return NextResponse.json({ ok: false, error }, { status: 400 });
  }
}
