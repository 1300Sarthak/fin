import { NextResponse } from "next/server";
import { detectRecurring } from "@/lib/recurring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const r = await detectRecurring();
    const message =
      r.seriesDetected === 0
        ? "No recurring charges found yet — needs a few months of history."
        : `Found ${r.seriesDetected} recurring ${r.seriesDetected === 1 ? "series" : "series"}` +
          (r.flagged ? ` · ${r.flagged} flagged` : "");
    return NextResponse.json({ ok: true, message, ...r });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Detection failed";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
