import { afterAll, beforeAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { getSessionGeneration } from "./generation";
import { hashPassword } from "./password";
import { loginLimiter } from "./rate-limit";
import { isValidSession, SESSION_COOKIE } from "./session";

const SECRET = "r".repeat(48);
const saved = { hash: process.env.FIN_PASSWORD_HASH, secret: process.env.FIN_SESSION_SECRET };
beforeAll(async () => {
  process.env.FIN_PASSWORD_HASH = await hashPassword("the owner password");
  process.env.FIN_SESSION_SECRET = SECRET;
});
afterAll(() => {
  if (saved.hash === undefined) delete process.env.FIN_PASSWORD_HASH; else process.env.FIN_PASSWORD_HASH = saved.hash;
  if (saved.secret === undefined) delete process.env.FIN_SESSION_SECRET; else process.env.FIN_SESSION_SECRET = saved.secret;
});

const post = (body: unknown, ip: string, extra: Record<string, string> = {}) =>
  new NextRequest("http://127.0.0.1:6767/api/auth/login", {
    method: "POST",
    headers: { host: "127.0.0.1:6767", origin: "http://127.0.0.1:6767", "content-type": "application/json", "x-forwarded-for": ip, ...extra },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => res.headers.get("set-cookie") ?? "";
const tokenOf = (res: Response) => /fin_session=([^;]*)/.exec(cookieOf(res))?.[1] ?? "";

test("right password sets an HttpOnly Lax cookie and returns a sanitized next", async () => {
  const res = await login(post({ password: "the owner password", remember: true, next: "//evil.example" }, "10.0.0.1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, next: "/" });
  const cookie = cookieOf(res);
  expect(cookie).toContain("HttpOnly");
  expect(cookie.toLowerCase()).toContain("samesite=lax");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Max-Age=2592000");
  expect(cookie).not.toContain("Secure");
  expect(isValidSession(tokenOf(res), SECRET, await getSessionGeneration())).toBe(true);
});

test("without remember-me the cookie is a browser-session cookie; https adds Secure", async () => {
  const res = await login(post({ password: "the owner password", remember: false, next: "/spending" }, "10.0.0.2", { "x-forwarded-proto": "https" }));
  expect(await res.json()).toEqual({ ok: true, next: "/spending" });
  expect(cookieOf(res)).not.toContain("Max-Age");
  expect(cookieOf(res)).toContain("Secure");
});

test("wrong passwords get one generic message, then 429 with Retry-After", async () => {
  const ip = "10.9.9.9";
  for (let i = 0; i < 5; i++) {
    const res = await login(post({ password: `guess ${i}` }, ip));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "That password is not right." });
  }
  await login(post({ password: "guess 6" }, ip)); // sixth failure starts the backoff
  const blocked = await login(post({ password: "the owner password" }, ip));
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(cookieOf(blocked)).toBe("");
  loginLimiter.succeed(ip);
});

test("cross-origin login posts are refused", async () => {
  const res = await login(post({ password: "the owner password" }, "10.0.0.3", { origin: "https://evil.example" }));
  expect(res.status).toBe(403);
});

test("sign out everywhere needs a session, bumps the generation, and kills old cookies", async () => {
  const signedIn = tokenOf(await login(post({ password: "the owner password", remember: true }, "10.0.0.4")));
  const form = (cookie?: string) => new NextRequest("http://127.0.0.1:6767/api/auth/logout", {
    method: "POST",
    headers: { host: "127.0.0.1:6767", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) },
    body: "everywhere=1",
  });
  expect((await logout(form())).status).toBe(401);
  const before = await getSessionGeneration();
  const res = await logout(form(signedIn));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/login?signedOut=all");
  expect(cookieOf(res)).toContain("Max-Age=0");
  expect(await getSessionGeneration()).toBe(before + 1);
  expect(isValidSession(signedIn, SECRET, await getSessionGeneration())).toBe(false);
});
