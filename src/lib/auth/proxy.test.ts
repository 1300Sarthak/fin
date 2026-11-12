import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { hashPassword } from "./password";

/** proxy() end to end with the real process env, the way Next calls it. */
const local = { host: "127.0.0.1:6767", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:6767" };
const req = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  new NextRequest(`http://127.0.0.1:6767${path}`, { method, headers: { ...local, ...headers } });
afterEach(() => { delete process.env.FIN_PASSWORD_HASH; delete process.env.FIN_SESSION_SECRET; });

test("keeps the cross-origin refusal and the security headers", async () => {
  const refused = await proxy(req("/api/fin", "POST", { origin: "https://evil.example" }));
  expect(refused.status).toBe(403);
  const ok = await proxy(req("/api/fin"));
  expect(ok.headers.get("x-middleware-next")).toBe("1");
  expect(ok.headers.get("x-frame-options")).toBe("DENY");
  expect(ok.headers.get("cache-control")).toBe("no-store");
});

test("with a password set, pages redirect and APIs 401 — still with security headers", async () => {
  process.env.FIN_PASSWORD_HASH = await hashPassword("owner password!");
  process.env.FIN_SESSION_SECRET = "q".repeat(40);
  const page = await proxy(req("/transactions"));
  expect(page.status).toBe(307);
  expect(page.headers.get("location")).toContain("/login?next=%2Ftransactions");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  const api = await proxy(req("/api/assistant", "POST", { origin: "http://127.0.0.1:6767" }));
  expect(api.status).toBe(401);
  expect((await proxy(req("/login"))).headers.get("x-middleware-next")).toBe("1");
});

test("marks only /login as bare, overriding anything the client sent", async () => {
  const bare = (res: Response) => res.headers.get("x-middleware-request-x-fin-bare");
  expect(bare(await proxy(req("/login")))).toBe("1");
  expect(bare(await proxy(req("/spending", "GET", { "x-fin-bare": "1" })))).toBe("0");
});
