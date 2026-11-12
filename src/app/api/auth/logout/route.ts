import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie } from "@/lib/auth/cookie";
import { readAuthConfig } from "@/lib/auth/env";
import { bumpSessionGeneration, getSessionGeneration } from "@/lib/auth/generation";
import { isSecureRequest } from "@/lib/auth/policy";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth/session";
import { readBoundedBody } from "@/lib/bounded-request";

export const runtime = "nodejs";

/**
 * Sign out. A plain HTML form posts here (no JS needed) and is sent to /login
 * with 303; a fetch with JSON gets JSON back. `everywhere=1` also bumps the
 * session generation so every other device's cookie stops working — only a
 * signed-in caller may do that. The proxy has already refused cross-origin posts.
 */
export async function POST(request: NextRequest) {
  const type = request.headers.get("content-type") ?? "";
  const isForm = type.includes("application/x-www-form-urlencoded");
  let everywhere = false;
  try {
    const raw = new TextDecoder().decode(await readBoundedBody(request, 1_000));
    if (isForm) everywhere = new URLSearchParams(raw).get("everywhere") === "1";
    else if (type.includes("application/json") && raw) everywhere = (JSON.parse(raw) as { everywhere?: unknown })?.everywhere === true;
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read the request." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const config = readAuthConfig();
  if (everywhere) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (config.state !== "enabled" || !isValidSession(token, config.secret, await getSessionGeneration())) {
      return NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    await bumpSessionGeneration();
  }

  const response = isForm
    // Relative on purpose: behind Caddy/Tailscale `request.url` can name the internal host.
    ? new NextResponse(null, { status: 303, headers: { Location: `/login?signedOut=${everywhere ? "all" : "1"}`, "Cache-Control": "no-store" } })
    : NextResponse.json({ ok: true, everywhere }, { headers: { "Cache-Control": "no-store" } });
  clearSessionCookie(response, isSecureRequest(request.nextUrl, request.headers));
  return response;
}
