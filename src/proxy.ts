import { NextResponse, type NextRequest } from "next/server";

/**
 * This is a single-owner local app. Origin checks protect local mutation routes.
 *
 * Compare against the `Host` the browser actually used, not `nextUrl.origin`:
 * Next reports the latter as `localhost` whatever address the server is bound
 * to, so a page opened at `http://127.0.0.1:6767` — which is what every script
 * here prints — would fail its own same-origin check and 403 every save.
 * A browser sets both headers itself and a page cannot forge either.
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

export function proxy(request: NextRequest) {
  const mutates = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (mutates && (!isSameOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site")) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (request.nextUrl.pathname.startsWith("/api/")) response.headers.set("Cache-Control", "no-store");
  return response;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
