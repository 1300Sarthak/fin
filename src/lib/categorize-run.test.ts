import { describe, expect, test } from "bun:test";
import { busyLabel, requestCategorize, runReducer, type RunState } from "./categorize-run";

const done = { kind: "done", message: "Categorized 4, 0 left for you", categorized: 4, left: 0 } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("button state", () => {
  test("a finished run refreshes, then returns to idle", () => {
    let s: RunState = { phase: "idle" };
    s = runReducer(s, { type: "start" });
    expect(busyLabel(s)).toBe("Categorizing…");
    s = runReducer(s, { type: "finish", outcome: done });
    expect(busyLabel(s)).toBe("Updating…");
    s = runReducer(s, { type: "refreshed" });
    expect(s).toEqual({ phase: "idle" });
    expect(busyLabel(s)).toBeNull();
  });
  test("an error or a cancel goes straight back to idle", () => {
    for (const outcome of [{ kind: "error", message: "x" }, { kind: "cancelled", message: "y" }] as const) {
      expect(runReducer({ phase: "running" }, { type: "finish", outcome })).toEqual({ phase: "idle" });
    }
  });
  test("a second click while running is ignored", () => {
    expect(runReducer({ phase: "running" }, { type: "start" })).toEqual({ phase: "running" });
  });
});

describe("request always resolves", () => {
  test("success carries the server's message and counts", async () => {
    const out = await requestCategorize(new AbortController().signal, async () => json({ ok: true, message: "Categorized 4, 0 left for you", categorized: 4, left: 0 }));
    expect(out).toEqual(done);
  });
  test("an HTML error page becomes an error, not a hang", async () => {
    const out = await requestCategorize(new AbortController().signal, async () => new Response("<html>500</html>", { status: 500 }));
    expect(out).toEqual({ kind: "error", message: "Categorize failed (HTTP 500)" });
  });
  test("a server-reported failure keeps its message", async () => {
    const out = await requestCategorize(new AbortController().signal, async () => json({ ok: false, error: "No AI provider" }, 500));
    expect(out).toEqual({ kind: "error", message: "No AI provider" });
  });
  test("a network failure is an error", async () => {
    const out = await requestCategorize(new AbortController().signal, async () => { throw new TypeError("Failed to fetch"); });
    expect(out).toEqual({ kind: "error", message: "Failed to fetch" });
  });
  test("Stop aborts a request that would never answer", async () => {
    const ac = new AbortController();
    const never = (_: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const pending = requestCategorize(ac.signal, never);
    ac.abort();
    expect((await pending).kind).toBe("cancelled");
  });
});
