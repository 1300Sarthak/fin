import { NextResponse, type NextRequest } from "next/server";
import { gate } from "@/lib/auth/gate";
import { BARE_HEADER } from "@/lib/auth/policy";

/**
 * Every request passes here first (Node runtime, the Next 16 default for proxy).
 * Two jobs: refuse cross-origin mutations, and require the owner's session on
 * everything except the sign-in screen and the assets it needs (src/lib/auth/policy.ts).
 *
 * The origin check compares against the `Host` the browser actually used, not
 * `nextUrl.origin`: Next reports the latter as `localhost` whatever address the
 * server is bound to, so a page opened at `http://127.0.0.1:6767` — which is what
 * every script here prints — would fail its own same-origin check and 403 every
 * save. A browser sets both headers itself and a page cannot forge either.
 *
 * The CLI and the sync/bot workers import src/lib directly, never over HTTP, so
 * none of this applies to them.
 */
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser clients (curl, the CLI) send none.
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function secure(response: NextResponse, request: NextRequest) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (request.nextUrl.pathname.startsWith("/api/")) response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function proxy(request: NextRequest) {
  const mutates = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (mutates && (!isSameOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site")) {
    return secure(NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 }), request);
  }
  const refused = await gate(request);
  if (refused) return secure(refused, request);
  // Tells the root layout to render /login without the app shell. Always set
  // here, so a client cannot choose it for any other path.
  const headers = new Headers(request.headers);
  headers.set(BARE_HEADER, request.nextUrl.pathname === "/login" ? "1" : "0");
  return secure(NextResponse.next({ request: { headers } }), request);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
