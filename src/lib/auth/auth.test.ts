import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { readAuthConfig } from "./env";
import { gate } from "./gate";
import { bumpSessionGeneration, getSessionGeneration } from "./generation";
import { sanitizeNext } from "./next-param";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password";
import { cameThroughProxy, clientKey, isLoopbackHost, isPublicPath, isSecureRequest, noAuthAllowed } from "./policy";
import { LoginLimiter } from "./rate-limit";
import { createSessionToken, isValidSession, REMEMBER_MS, SESSION_COOKIE, SESSION_MS, verifySessionToken } from "./session";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 10, 11, 12);

describe("password", () => {
  test("hashes and verifies; rejects the wrong password and malformed hashes", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt:15:8:1:[\w-]+:[\w-]+$/);
    expect(hash).not.toContain("$");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("x".repeat(2000), hash)).toBe(false);
    expect(await verifyPassword("correct horse battery", "nope")).toBe(false);
  });
  test("refuses cost parameters outside sane bounds", () => {
    const salt = Buffer.alloc(16).toString("base64url");
    const key = Buffer.alloc(32).toString("base64url");
    expect(parsePasswordHash(`scrypt:15:8:1:${salt}:${key}`)).not.toBeNull();
    expect(parsePasswordHash(`scrypt:30:8:1:${salt}:${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt:15:99:1:${salt}:${key}`)).toBeNull();
    expect(parsePasswordHash(`scrypt:15:8:1:${salt}:AAAA`)).toBeNull();
  });
});

describe("session token", () => {
  test("round-trips and carries the right expiry", () => {
    const remember = createSessionToken({ gen: 3, remember: true, now: NOW }, SECRET);
    expect(verifySessionToken(remember.token, SECRET, NOW + 1000)).toEqual(remember.payload);
    expect(remember.payload.exp - NOW).toBe(REMEMBER_MS);
    expect(createSessionToken({ gen: 3, remember: false, now: NOW }, SECRET).payload.exp - NOW).toBe(SESSION_MS);
  });
  test("rejects tampering, a wrong secret, and junk", () => {
    const { token } = createSessionToken({ gen: 0, remember: true, now: NOW }, SECRET);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), gen: 9 })).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifySessionToken(`${body}.${sig.slice(0, -2)}AA`, SECRET, NOW)).toBeNull();
    expect(verifySessionToken(token, "t".repeat(40), NOW)).toBeNull();
    for (const junk of ["", ".", "a.b.c", body, `${body}.`, "x".repeat(2000)]) expect(verifySessionToken(junk, SECRET, NOW)).toBeNull();
  });
  test("rejects expired and far-future-issued tokens", () => {
    const { token, payload } = createSessionToken({ gen: 0, remember: false, now: NOW }, SECRET);
    expect(verifySessionToken(token, SECRET, payload.exp - 1)).not.toBeNull();
    expect(verifySessionToken(token, SECRET, payload.exp)).toBeNull();
    expect(verifySessionToken(token, SECRET, NOW - 5 * 60_000)).toBeNull();
  });
  test("a generation bump invalidates earlier sessions", async () => {
    const before = await getSessionGeneration();
    const { token } = createSessionToken({ gen: before, remember: true }, SECRET);
    expect(isValidSession(token, SECRET, await getSessionGeneration())).toBe(true);
    expect(await bumpSessionGeneration()).toBe(before + 1);
    expect(isValidSession(token, SECRET, await getSessionGeneration())).toBe(false);
    const fresh = createSessionToken({ gen: await getSessionGeneration(), remember: true }, SECRET).token;
    expect(isValidSession(fresh, SECRET, await getSessionGeneration())).toBe(true);
  });
});

describe("next parameter", () => {
  test("keeps same-origin relative paths", () => {
    expect(sanitizeNext("/spending?from=2026-01-01&to=2026-01-31#top")).toBe("/spending?from=2026-01-01&to=2026-01-31#top");
    expect(sanitizeNext("/")).toBe("/");
    expect(sanitizeNext("/a/../transactions")).toBe("/transactions");
  });
  test("drops anything that could leave the site or loop", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "/%5Cevil", "javascript:alert(1)",
      "evil.example", " /x", "/\tx", "/x\n", "/login", "/login?next=/x", "/api/fin", "/api", "", null, undefined, 42, "/" + "a".repeat(3000)]) {
      const out = sanitizeNext(bad);
      expect(out.startsWith("/") && !out.startsWith("//") && !out.startsWith("/login") && !out.startsWith("/api")).toBe(true);
      expect(new URL(out, "https://fin.example").origin).toBe("https://fin.example");
    }
    expect(sanitizeNext("//evil.example")).toBe("/");
    for (const dotted of ["/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/a/..//evil.com", "/.%2e//evil.com", "/%2e%2e//evil.com/x?y#z"]) expect(sanitizeNext(dotted)).toBe("/");
    expect(sanitizeNext("/\\evil.example")).toBe("/");
  });
});

describe("rate limit", () => {
  test("per-client backoff doubles after the free failures and clears on success", () => {
    const limiter = new LoginLimiter({ freeFailures: 3, baseMs: 1000, maxMs: 8000 }, { freeFailures: 100, baseMs: 1000, maxMs: 60_000 });
    for (let i = 0; i < 3; i++) { expect(limiter.check("a", NOW).ok).toBe(true); limiter.fail("a", NOW); }
    expect(limiter.check("a", NOW).ok).toBe(true);
    limiter.fail("a", NOW);
    expect(limiter.check("a", NOW)).toEqual({ ok: false, retryAfterMs: 1000 });
    limiter.fail("a", NOW + 1000);
    expect(limiter.check("a", NOW + 1000)).toEqual({ ok: false, retryAfterMs: 2000 });
    for (let i = 0; i < 10; i++) limiter.fail("a", NOW + 2000);
    expect(limiter.check("a", NOW + 2000)).toEqual({ ok: false, retryAfterMs: 8000 });
    expect(limiter.check("b", NOW + 2000).ok).toBe(true);
    limiter.succeed("a");
    expect(limiter.check("a", NOW + 2000).ok).toBe(true);
  });
  test("the global bucket throttles even when every attempt uses a new client key", () => {
    const limiter = new LoginLimiter({ freeFailures: 5, baseMs: 1000, maxMs: 60_000 }, { freeFailures: 4, baseMs: 500, maxMs: 4000 });
    for (let i = 0; i < 5; i++) limiter.fail(`ip-${i}`, NOW);
    expect(limiter.check("someone-new", NOW)).toEqual({ ok: false, retryAfterMs: 500 });
    expect(limiter.check("someone-new", NOW + 500).ok).toBe(true);
  });
  test("attempt() counts before the slow hash, so parallel guesses cannot all pass", () => {
    const limiter = new LoginLimiter({ freeFailures: 5, baseMs: 1000, maxMs: 60_000 }, { freeFailures: 100, baseMs: 1, maxMs: 1 });
    const verdicts = Array.from({ length: 50 }, () => limiter.attempt("a", NOW));
    expect(verdicts.filter((v) => v.ok).length).toBe(6);
  });
  test("a quiet hour resets a client", () => {
    const limiter = new LoginLimiter({ freeFailures: 1, baseMs: 1000, maxMs: 60_000 }, { freeFailures: 100, baseMs: 1, maxMs: 1 });
    limiter.fail("a", NOW); limiter.fail("a", NOW);
    expect(limiter.check("a", NOW).ok).toBe(false);
    expect(limiter.check("a", NOW + 61 * 60_000).ok).toBe(true);
  });
});

describe("policy", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  test("public paths", () => {
    for (const p of ["/login", "/api/auth/login", "/api/auth/logout", "/_next/static/chunks/a.js", "/favicon.ico", "/manifest.webmanifest", "/icons/icon-192.png"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/", "/spending", "/api/fin", "/api/assistant", "/login-x", "/loginx", "/api/authx", "/icons/../api/fin", "/icons/a/b.png"]) expect(isPublicPath(p)).toBe(false);
  });
  test("loopback host and proxy detection", () => {
    expect(isLoopbackHost("127.0.0.1:6767")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]:6767")).toBe(true);
    expect(isLoopbackHost("server.example-tailnet.ts.net")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    // What Next itself adds for a direct local request.
    const local = { host: "127.0.0.1:6767", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:6767", "x-forwarded-proto": "http" };
    expect(cameThroughProxy(h(local))).toBe(false);
    expect(cameThroughProxy(h({ ...local, "x-forwarded-for": "100.64.1.2" }))).toBe(true);
    expect(cameThroughProxy(h({ ...local, "x-forwarded-for": "100.64.1.2, 127.0.0.1" }))).toBe(true);
    expect(cameThroughProxy(h({ ...local, "x-forwarded-host": "server.example-tailnet.ts.net" }))).toBe(true);
    expect(cameThroughProxy(h({ ...local, "tailscale-user-login": "owner@example.com" }))).toBe(true);
    expect(noAuthAllowed(h(local), { NODE_ENV: "development" })).toBe(true);
    expect(noAuthAllowed(h(local), { NODE_ENV: "production" })).toBe(false);
    expect(noAuthAllowed(h(local), { NODE_ENV: "production", FIN_ALLOW_NO_AUTH: "loopback" })).toBe(true);
    expect(noAuthAllowed(h({ ...local, host: "fin.example" }), { NODE_ENV: "development" })).toBe(false);
  });
  test("secure cookie decision and client key", () => {
    const http = new URL("http://127.0.0.1:6767/");
    expect(isSecureRequest(http, h({}), {})).toBe(false);
    expect(isSecureRequest(http, h({ "x-forwarded-proto": "https" }), {})).toBe(true);
    expect(isSecureRequest(new URL("https://x/"), h({}), {})).toBe(true);
    expect(isSecureRequest(http, h({}), { FIN_COOKIE_SECURE: "1" })).toBe(true);
    expect(isSecureRequest(new URL("https://x/"), h({}), { FIN_COOKIE_SECURE: "0" })).toBe(false);
    expect(clientKey(h({ "x-forwarded-for": "6.6.6.6, 10.0.0.9" }))).toBe("10.0.0.9");
    expect(clientKey(h({}))).toBe("direct");
    expect(clientKey(h({ "tailscale-user-login": "owner@github", "x-forwarded-for": "172.20.0.1" }))).toBe("ts:owner@github");
  });
  test("config states", () => {
    expect(readAuthConfig({}).state).toBe("disabled");
    expect(readAuthConfig({ FIN_PASSWORD_HASH: "garbage", FIN_SESSION_SECRET: SECRET }).state).toBe("misconfigured");
  });
});

describe("gate (what proxy.ts returns)", async () => {
  const hash = await hashPassword("owner password");
  const env = { NODE_ENV: "production", FIN_PASSWORD_HASH: hash, FIN_SESSION_SECRET: SECRET };
  const generation = async () => 7;
  const local = { host: "127.0.0.1:6767", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:6767" };
  const req = (path: string, init: { method?: string; headers?: Record<string, string>; cookie?: string } = {}) =>
    new NextRequest(`http://127.0.0.1:6767${path}`, { method: init.method ?? "GET", headers: { ...local, ...init.headers, ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}) } });
  const valid = createSessionToken({ gen: 7, remember: true }, SECRET).token;

  test("a page without a session redirects to /login with next", async () => {
    const res = await gate(req("/spending?from=2026-01-01"), { env, generation });
    expect(res?.status).toBe(307);
    const location = new URL(res!.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/spending?from=2026-01-01");
    expect(new URL((await gate(req("/"), { env, generation }))!.headers.get("location")!).search).toBe("");
  });
  test("API calls without a session get 401 JSON, including /api/fin and /api/assistant", async () => {
    for (const path of ["/api/fin", "/api/assistant", "/api/transactions?q=x"]) {
      const res = await gate(req(path), { env, generation });
      expect(res?.status).toBe(401);
      expect(await res!.json()).toEqual({ ok: false, error: "Sign in to continue." });
    }
    expect((await gate(req("/spending", { method: "POST" }), { env, generation }))?.status).toBe(401);
  });
  test("login, its API, and static assets pass without a session", async () => {
    for (const path of ["/login", "/login?next=/x", "/api/auth/login", "/_next/static/chunks/main.js", "/icons/icon-192.png", "/manifest.webmanifest"]) {
      expect(await gate(req(path), { env, generation })).toBeNull();
    }
  });
  test("a valid session passes; stale generation, tampering, and wrong secret do not", async () => {
    expect(await gate(req("/", { cookie: valid }), { env, generation })).toBeNull();
    expect(await gate(req("/api/fin", { cookie: valid }), { env, generation })).toBeNull();
    const stale = createSessionToken({ gen: 6, remember: true }, SECRET).token;
    const res = await gate(req("/api/fin", { cookie: stale }), { env, generation });
    expect(res?.status).toBe(401);
    expect(res!.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
    expect((await gate(req("/", { cookie: valid.slice(0, -3) + "AAA" }), { env, generation }))?.status).toBe(307);
    expect((await gate(req("/", { cookie: valid }), { env: { ...env, FIN_SESSION_SECRET: "z".repeat(40) }, generation }))?.status).toBe(307);
  });
  test("no password: open only for a loopback request to a dev process, 503 otherwise", async () => {
    const devNoAuth = { NODE_ENV: "development" };
    expect(await gate(req("/"), { env: devNoAuth })).toBeNull();
    expect((await gate(req("/", { headers: { "x-forwarded-for": "100.100.1.1" } }), { env: devNoAuth }))?.status).toBe(503);
    expect((await gate(req("/api/fin", { headers: { host: "server.example-tailnet.ts.net", "x-forwarded-host": "server.example-tailnet.ts.net" } }), { env: devNoAuth }))?.status).toBe(503);
    // The homelab: production, bound to 0.0.0.0, no hash. Closed even to a forged loopback request.
    expect((await gate(req("/"), { env: { NODE_ENV: "production" } }))?.status).toBe(503);
  });
  test("a malformed hash or short secret fails closed", async () => {
    expect((await gate(req("/", { cookie: valid }), { env: { ...env, FIN_SESSION_SECRET: "short" }, generation }))?.status).toBe(503);
    expect((await gate(req("/api/fin"), { env: { ...env, FIN_PASSWORD_HASH: "scrypt:1:1:1:a:b" }, generation }))?.status).toBe(503);
  });
});
