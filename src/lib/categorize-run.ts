/**
 * The Categorize button's request and state, kept apart from React so the
 * "stuck on Categorizing…" class of bug can be tested: every path out of a
 * run, including a cancel, a dead server, or an HTML error page, ends in an
 * outcome and returns the button to idle.
 */

export type Outcome =
  | { kind: "done"; message: string; categorized: number; left: number }
  | { kind: "cancelled"; message: string }
  | { kind: "error"; message: string };

export type RunState = { phase: "idle" } | { phase: "running" } | { phase: "refreshing"; outcome: Outcome };
export type RunEvent = { type: "start" } | { type: "finish"; outcome: Outcome } | { type: "refreshed" };

export function runReducer(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "start":
      return state.phase === "idle" ? { phase: "running" } : state;
    case "finish":
      // Only a successful run has fresh rows worth waiting for.
      return state.phase === "running" ? (event.outcome.kind === "done" ? { phase: "refreshing", outcome: event.outcome } : { phase: "idle" }) : state;
    case "refreshed":
      return { phase: "idle" };
  }
}

export const busyLabel = (s: RunState) => (s.phase === "running" ? "Categorizing…" : s.phase === "refreshing" ? "Updating…" : null);

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** POST /api/categorize and reduce whatever comes back to an outcome. Never throws. */
export async function requestCategorize(signal: AbortSignal, fetchImpl: Fetch = fetch): Promise<Outcome> {
  try {
    const res = await fetchImpl("/api/categorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; message?: string; error?: string; categorized?: number; left?: number; stopped?: boolean }
      | null;
    if (!res.ok || !data || data.ok === false) return { kind: "error", message: data?.error ?? `Categorize failed (HTTP ${res.status})` };
    return { kind: "done", message: data.message ?? "Done", categorized: data.categorized ?? 0, left: data.left ?? 0 };
  } catch (e) {
    if (signal.aborted) return { kind: "cancelled", message: "Stopped. Rows already filed keep their category." };
    return { kind: "error", message: e instanceof Error && e.message ? e.message : "Categorize failed" };
  }
}
