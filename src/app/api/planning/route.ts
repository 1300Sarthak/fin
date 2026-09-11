import { getFinancialPlanningContext, savePlanningProfile } from "@/lib/financial-planning";
import { z } from "zod";
import { readBoundedJson, RequestBodyTooLarge } from "@/lib/bounded-request";

export const runtime = "nodejs";
export async function GET() {
  return Response.json(await getFinancialPlanningContext(), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  try {
    const profile = await savePlanningProfile(await readBoundedJson(request));
    return Response.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return Response.json({ error: "Planning profile exceeds 20 KB." }, { status: 413 });
    // Name the offending fields: a generic message makes a wrong-shaped
    // payload indistinguishable from a wrong-valued one.
    const fields = error instanceof z.ZodError
      ? [...new Set(error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 8).join(", ")
      : "";
    if (fields) return Response.json({ error: `Check these fields: ${fields}. Amounts must be nonnegative numbers, tax year must be 2026, and unknown fields are rejected.` }, { status: 400 });
    // A thrown Error here is already a written-for-humans message.
    return Response.json({ error: error instanceof Error ? error.message : "Could not save the planning profile." }, { status: 400 });
  }
}
