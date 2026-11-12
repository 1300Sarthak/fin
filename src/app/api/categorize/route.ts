import { z } from "zod";
import { categorizeUncategorized } from "@/lib/categorize";
import { detectTransfers } from "@/lib/transfers";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The page waits on this request; anything left over is picked up by the next run or sync. */
const WEB_DEADLINE_MS = 180_000;
const WEB_MAX_AI = 200;

const Body = z.object({ limit: z.number().int().min(1).max(5000).optional() }).strict();

/**
 * { limit? } → { ok, message, categorized, left, … }. Always answers: a
 * provider failure is reported in the summary, and a cancelled request (the
 * page's Stop button aborts the fetch) stops between AI batches, keeping
 * whatever was already filed.
 */
export async function POST(request: Request) {
  const read = await readJsonPost(request, 1_000);
  if (read instanceof Response) return read;
  const body = Body.safeParse(read.body ?? {});
  if (!body.success) return fail("Send { limit?: number }.", 400);
  try {
    await detectTransfers();
    const r = await categorizeUncategorized({
      limit: body.data.limit,
      maxAI: WEB_MAX_AI,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(WEB_DEADLINE_MS)]),
      trigger: "web",
    });
    return Response.json({ ...r, ok: true }, { headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    return fail(message && !message.startsWith("Failed query") ? message : "Categorize failed", 500);
  }
}
