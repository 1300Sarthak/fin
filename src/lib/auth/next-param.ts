/**
 * Where to go after signing in. Only a same-origin relative path survives;
 * anything else (absolute URLs, `//host`, `/\host`, control characters, the
 * login page itself, API routes) becomes "/". No open redirect.
 */
const BASE = "http://fin.invalid";

export function sanitizeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  let url: URL;
  try { url = new URL(raw, BASE); } catch { return "/"; }
  if (url.origin !== BASE) return "/";
  const path = url.pathname;
  // Dot segments collapse during parsing: "/.//evil.com" becomes "//evil.com", a protocol-relative URL.
  if (path.startsWith("//")) return "/";
  if (path === "/login" || path.startsWith("/login/") || path === "/api" || path.startsWith("/api/")) return "/";
  return `${path}${url.search}${url.hash}`;
}
