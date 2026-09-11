import { NextResponse } from "next/server";
import {
  getMilestones,
  upsertMilestone,
  deleteMilestone,
  type MilestoneLine,
} from "@/lib/milestones";

export const runtime = "nodejs";

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Tolerates lines arriving as dollars (`amount`) or cents (`cents`). */
function toLines(raw: unknown): MilestoneLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      const o = l as { label?: string; cents?: number; amount?: number; note?: string };
      const cents =
        typeof o.cents === "number"
          ? o.cents
          : typeof o.amount === "number"
            ? Math.round(o.amount * 100)
            : NaN;
      return { label: String(o.label ?? "").trim(), cents, note: o.note ?? null };
    })
    .filter((l) => l.label && Number.isFinite(l.cents));
}

export async function GET() {
  try {
    return NextResponse.json({ ok: true, milestones: await getMilestones() });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to load milestones";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (!isDate(body.date)) {
      return NextResponse.json(
        { ok: false, error: "date must be YYYY-MM-DD" },
        { status: 400 },
      );
    }

    const included = toLines(body.included);
    if (!included.length) {
      return NextResponse.json(
        { ok: false, error: "at least one account line is required" },
        { status: 400 },
      );
    }

    // An omitted total falls back to the sum of the lines (handled downstream).
    const rawTotal = body.totalCents ?? body.total;
    const totalCents =
      typeof body.totalCents === "number"
        ? body.totalCents
        : typeof rawTotal === "number"
          ? Math.round(rawTotal * 100)
          : undefined;

    const id = await upsertMilestone({
      date: body.date,
      label: typeof body.label === "string" ? body.label : undefined,
      totalCents,
      goal: typeof body.goal === "string" ? body.goal : null,
      note: typeof body.note === "string" ? body.note : null,
      included,
      excluded: toLines(body.excluded),
    });

    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to save milestone";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = (await req.json()) as { id?: number };
    if (!id) {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    await deleteMilestone(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to delete milestone";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
