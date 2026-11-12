import { z } from "zod";
import { getTakeHome, saveTakeHomeInputs } from "@/lib/take-home";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";

export const runtime = "nodejs";
const MAX_BYTES = 2_000;

function failure(error: unknown) {
  if (error instanceof z.ZodError) return fail(`Check these fields: ${[...new Set(error.issues.flatMap((i) => ("keys" in i ? i.keys : [i.path.join(".") || "(root)"])))].slice(0, 6).join(", ")}.`, 400);
  const message = error instanceof Error ? error.message : "";
  return fail(message && !message.startsWith("Failed query") ? message : "Could not compute take-home.", 400);
}

/** The 2026 after-tax estimate — the same report as `fin take-home --json`. */
export async function GET() {
  try { return Response.json({ ok: true, takeHome: await getTakeHome(2026) }, { headers }); }
  catch (error) { return failure(error); }
}

/** Save assumptions: { annualSalaryCents?, employmentStart?, ytdGrossCents?, ytdAsOf?, pretaxDeferralsCents?, expectedSeCents? } (null clears). */
export async function POST(request: Request) {
  const read = await readJsonPost(request, MAX_BYTES);
  if (read instanceof Response) return read;
  try { return Response.json({ ok: true, inputs: await saveTakeHomeInputs(read.body) }, { headers }); }
  catch (error) { return failure(error); }
}
