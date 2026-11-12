import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, headers, readJsonPost } from "@/lib/assistant/http";
import { setSessionCookie } from "@/lib/auth/cookie";
import { readAuthConfig } from "@/lib/auth/env";
import { getSessionGeneration } from "@/lib/auth/generation";
import { sanitizeNext } from "@/lib/auth/next-param";
import { MAX_PASSWORD_LENGTH, verifyPassword } from "@/lib/auth/password";
import { clientKey, isSecureRequest } from "@/lib/auth/policy";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { createSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";

const body = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  remember: z.boolean().default(true),
  next: z.string().max(2048).optional(),
}).strict();

/** One message for every wrong answer, so the response says nothing about why. */
const WRONG = "That password is not right.";

/** { password, remember?, next? } → sets the session cookie and returns where to go. */
export async function POST(request: Request) {
  const config = readAuthConfig();
  if (config.state !== "enabled") return fail("Sign-in is not set up on this server.", 503);

  const read = await readJsonPost(request, 4_000);
  if (read instanceof Response) return read;
  const parsed = body.safeParse(read.body);
  if (!parsed.success) return fail("Enter your password.", 400);

  // Counted before the password is even hashed: a throttled guess costs nothing and reveals
  // nothing, and parallel guesses cannot all slip past the check while scrypt runs.
  const key = clientKey(request.headers);
  const verdict = loginLimiter.attempt(key);
  if (!verdict.ok) {
    const seconds = Math.ceil(verdict.retryAfterMs / 1000);
    return Response.json(
      { ok: false, error: `Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, retryAfter: seconds },
      { status: 429, headers: { ...headers, "Retry-After": String(seconds) } },
    );
  }

  if (!(await verifyPassword(parsed.data.password, config.hash))) return fail(WRONG, 401);
  loginLimiter.succeed(key);

  const { token, payload } = createSessionToken({ gen: await getSessionGeneration(), remember: parsed.data.remember }, config.secret);
  const response = NextResponse.json({ ok: true, next: sanitizeNext(parsed.data.next) }, { headers });
  setSessionCookie(response, token, payload, isSecureRequest(new URL(request.url), request.headers));
  return response;
}
