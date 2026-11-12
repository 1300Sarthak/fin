import type { Env } from "./env";

/** Request header proxy.ts sets ("1" only on /login) so the root layout can skip the app shell. */
export const BARE_HEADER = "x-fin-bare";

/**
 * Pure request-classification rules for the proxy, kept apart so they can be
 * tested without a server.
 */

/** Reachable without a session: the sign-in screen, its API, and what a browser needs to draw it. */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) return true;
  // Framework assets: hashed JS/CSS, the image optimizer, and dev-server internals.
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/manifest.webmanifest" || pathname === "/robots.txt") return true;
  return pathname.startsWith("/icons/") && /^\/icons\/[\w.-]+\.(png|svg|ico|webp)$/.test(pathname);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Host header without its port: `127.0.0.1:6767` → `127.0.0.1`, `[::1]:6767` → `[::1]`. */
export function hostname(host: string | null): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : null;
  }
  return h.split(":")[0] || null;
}

export const isLoopbackHost = (host: string | null) => {
  const name = hostname(host);
  return name !== null && (LOOPBACK.has(name) || /^127(\.\d{1,3}){3}$/.test(name));
};

/** Any of these means a reverse proxy (Caddy, Tailscale Serve, a tunnel) carried the request here. */
const PROXY_HEADERS = ["forwarded", "x-real-ip", "tailscale-user-login", "tailscale-user-name", "cf-connecting-ip", "true-client-ip", "x-client-ip"];

/**
 * Next itself fills X-Forwarded-For/-Host/-Port/-Proto from the socket before the
 * proxy runs (`??=` in base-server), so a direct local request arrives with
 * `x-forwarded-for: 127.0.0.1` and `x-forwarded-host` equal to Host. Anything
 * beyond that — a non-loopback or multi-hop XFF, a different forwarded host, or a
 * proxy-specific header — means the request did not come straight from this machine.
 */
export function cameThroughProxy(headers: Headers): boolean {
  if (PROXY_HEADERS.some((name) => headers.has(name))) return true;
  const xff = headers.get("x-forwarded-for");
  if (xff !== null && !isLoopbackAddress(xff.trim())) return true;
  const forwardedHost = headers.get("x-forwarded-host");
  return forwardedHost !== null && forwardedHost !== headers.get("host");
}

const isLoopbackAddress = (ip: string) => ip === "::1" || ip === "::ffff:127.0.0.1" || /^127(\.\d{1,3}){3}$/.test(ip);

/**
 * May this request run with no password configured?
 *
 * The proxy cannot see the socket address (Next does not expose it there), and
 * every header is client-controlled, so headers alone can never prove a request
 * is local. The decision therefore needs a signal the operator controls:
 *
 * 1. Process: only a dev server (`next dev -H 127.0.0.1`, the `dev` script) or a
 *    production build explicitly started with FIN_ALLOW_NO_AUTH=loopback. The
 *    homelab runs `next start -H 0.0.0.0` in production with neither, so it
 *    fails closed whatever a client sends.
 * 2. Request: the Host is a loopback name AND no proxy-forwarding header is
 *    present. That catches the common accident of putting a reverse proxy or
 *    `tailscale serve` in front of a loopback dev server: they forward the real
 *    client in X-Forwarded-For, add their own headers, and usually the public Host.
 *
 * Residual gap, documented: someone who runs `next dev -H 0.0.0.0` with no
 * password and lets a remote client connect directly can forge a loopback Host
 * and X-Forwarded-For (Next keeps a client-sent XFF). The process rule above
 * is what keeps the production deployment closed.
 */
export function noAuthAllowed(headers: Headers, env: Env = process.env): boolean {
  const processOk = env.NODE_ENV !== "production" || env.FIN_ALLOW_NO_AUTH === "loopback";
  return processOk && isLoopbackHost(headers.get("host")) && !cameThroughProxy(headers);
}

/** Secure cookie when the browser reached us over HTTPS (directly or per the proxy), or when told to. */
export function isSecureRequest(url: URL, headers: Headers, env: Env = process.env): boolean {
  if (env.FIN_COOKIE_SECURE === "1") return true;
  if (env.FIN_COOKIE_SECURE === "0") return false;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https" || url.protocol === "https:";
}

/**
 * Rate-limit key. Tailscale Serve sets Tailscale-User-Login itself (a client
 * cannot supply it through Serve), so a signed-in tailnet user gets their own
 * bucket and a different device cannot throttle them. Otherwise the right-most X-Forwarded-For entry is the one our nearest
 * proxy appended, so a client cannot choose it by sending its own header. Behind
 * Caddy + Tailscale Serve every client looks alike, which degrades per-IP
 * limiting into the global limit; that is safe, just coarser.
 */
export function clientKey(headers: Headers): string {
  const tailnetUser = headers.get("tailscale-user-login")?.trim();
  if (tailnetUser) return `ts:${tailnetUser.slice(0, 200)}`;
  const xff = headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean);
  return xff?.at(-1) || headers.get("x-real-ip")?.trim() || "direct";
}
