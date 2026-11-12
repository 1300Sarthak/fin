import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie } from "./cookie";
import { readAuthConfig, type Env } from "./env";
import { isPublicPath, isSecureRequest, noAuthAllowed } from "./policy";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export type GateDeps = { env?: Env; generation?: () => Promise<number>; now?: number };

const warned = globalThis as unknown as { __finAuthWarned?: Set<string> };
function warnOnce(message: string) {
  const seen = (warned.__finAuthWarned ??= new Set());
  if (seen.has(message)) return;
  seen.add(message);
  console.warn(`[fin auth] ${message}`);
}

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
const noStore = { "Cache-Control": "no-store" };

function refuse(request: NextRequest, status: 401 | 503, error: string) {
  if (isApi(request.nextUrl.pathname)) return NextResponse.json({ ok: false, error }, { status, headers: noStore });
  return new NextResponse(error, { status, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * Who may pass. Returns a response to send instead of the page, or null to let
 * the request through. Pages without a session redirect to /login?next=…;
 * API calls get 401 JSON; a server with a broken or missing password config
 * answers 503 unless it is a loopback-only process (see noAuthAllowed).
 */
export async function gate(request: NextRequest, deps: GateDeps = {}): Promise<NextResponse | null> {
  const env = deps.env ?? process.env;
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return null;

  const config = readAuthConfig(env);
  if (config.state === "misconfigured") {
    warnOnce(`${config.reason} Refusing every request until it is fixed.`);
    return refuse(request, 503, "Sign-in is misconfigured on this server.");
  }
  if (config.state === "disabled") {
    if (noAuthAllowed(request.headers, env)) {
      warnOnce("FIN_PASSWORD_HASH is not set. Serving without sign-in because this is a loopback request to a local process; anything forwarded or remote is refused.");
      return null;
    }
    warnOnce("FIN_PASSWORD_HASH is not set and this request is not a local loopback request. Refusing it; set FIN_PASSWORD_HASH and FIN_SESSION_SECRET.");
    return refuse(request, 503, "Sign-in is not configured on this server.");
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const payload = verifySessionToken(token, config.secret, deps.now);
  if (payload) {
    const current = await (deps.generation ?? (await import("./generation")).getSessionGeneration)();
    if (payload.gen === current) return null;
  }

  const secure = isSecureRequest(request.nextUrl, request.headers, env);
  let response: NextResponse;
  if (isApi(pathname) || !["GET", "HEAD"].includes(request.method)) {
    response = refuse(request, 401, "Sign in to continue.");
  } else {
    const login = new URL("/login", request.url);
    const next = `${pathname}${search}`;
    if (next !== "/") login.searchParams.set("next", next);
    response = NextResponse.redirect(login, 307);
    response.headers.set("Cache-Control", "no-store");
  }
  if (token) clearSessionCookie(response, secure);
  return response;
}
