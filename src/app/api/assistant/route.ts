import { z } from "zod";
import { assistantStatus, runAssistant } from "@/lib/assistant/agent";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";
import { ProviderError } from "@/lib/ai/types";

export const runtime = "nodejs";
export const maxDuration = 75;
let active = false;

const requestSchema = z.strictObject({
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20),
});

export async function GET() {
  return Response.json({ ok: true, ...assistantStatus() }, { headers });
}

export async function POST(request: Request) {
  const read = await readJsonPost(request, 160_000);
  if (read instanceof Response) return read;
  const parsed = requestSchema.safeParse(read.body);
  if (!parsed.success || parsed.data.messages.at(-1)?.role !== "user") return fail("Send 1-20 messages (each up to 4000 characters) ending with a user message.", 400);
  if (!assistantStatus().configured) return fail("The assistant is not configured. Set NVIDIA_API_KEY.", 503);
  if (active) return fail("The assistant is already answering. Wait for it to finish.", 429);
  active = true;
  try {
    const result = await runAssistant(parsed.data.messages, request.signal);
    return Response.json({ ok: true, ...result }, { headers });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError" || /time limit/.test((error as Error)?.message ?? "")) return fail("The assistant took too long. Try a narrower question.", 504);
    if (error instanceof ProviderError && error.kind === "auth") return fail("The assistant's provider rejected the request. Check NVIDIA_API_KEY.", 503);
    if (error instanceof ProviderError && error.kind === "rate") return fail("The provider is rate limiting requests. Try again shortly.", 429);
    return fail("The assistant's provider failed. Try again.", 502);
  } finally { active = false; }
}
