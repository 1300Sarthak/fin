import { NextResponse } from "next/server";
import { categorizeUncategorized } from "@/lib/categorize";
import { detectTransfers } from "@/lib/transfers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await detectTransfers();
    const r = await categorizeUncategorized();
    const parts: string[] = [];
    if (r.byRule) parts.push(`${r.byRule} by rules`);
    if (r.byCache) parts.push(`${r.byCache} cached`);
    if (r.byAI) parts.push(`${r.byAI} by AI`);

    let message: string;
    if (r.total === 0) message = "Everything is already categorized";
    else if (parts.length === 0) message = "No matches found";
    else {
      message = `Categorized ${parts.join(", ")}`;
      if (r.uncategorized) message += ` · ${r.uncategorized} left`;
    }
    if (r.note) message += `. ${r.note}`;

    return NextResponse.json({ ok: true, message, ...r });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Categorize failed";
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
