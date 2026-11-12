import { getResearchStatus, publicResearchError, runResearch } from "@/lib/ai/research";
import { researchRequestSchema } from "@/lib/ai/research-types";

export const runtime = "nodejs";
// Above RESEARCH_LIMITS.timeoutMs (240s), so the run's own limit answers first.
export const maxDuration = 260;
const headers = { "Cache-Control": "no-store" };
let active = false;

export async function GET() {
  return Response.json({ ok: true, ...getResearchStatus() }, { headers });
}

/** Match on the `Host` the browser used; `request.url` can report a different
 *  hostname than the address bar and would reject a legitimate same-origin post. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.get("host"); } catch { return false; }
}

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 18000) throw new Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("json");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 18000) { await reader.cancel(); throw new Error("size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ ok: false, error: "Cross-origin research requests are not allowed." }, { status: 403, headers });
  if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ ok: false, error: "Send an application/json request." }, { status: 415, headers });
  let input: unknown;
  try { input = await readBody(request); }
  catch (error) {
    const oversized = error instanceof Error && error.message === "size";
    return Response.json({ ok: false, error: oversized ? "Research request exceeds 18 KB." : "Research request must be valid JSON." }, { status: oversized ? 413 : 400, headers });
  }
  const parsed = researchRequestSchema.safeParse(input);
  if (!parsed.success) return Response.json({ ok: false, error: publicResearchError(parsed.error) }, { status: 400, headers });
  if (active) return Response.json({ ok: false, error: "A research run is already active. Wait for it to finish or cancel it first." }, { status: 429, headers });
  active = true;
  try {
    const result = await runResearch(parsed.data, request.signal);
    return Response.json({ ok: true, result }, { headers });
  } catch (error) {
    const message = publicResearchError(error);
    const status = /No AI provider|not configured/.test(message) ? 503 : /time limit|stopped/.test(message) ? 504 : 502;
    return Response.json({ ok: false, error: message }, { status, headers });
  } finally { active = false; }
}
