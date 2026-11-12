/**
 * `fin auth` — the CLI side of web sign-in. The CLI itself never needs a
 * password (it reads the database directly); this only reports how the web
 * app is configured in this shell's environment and can end every web session.
 */
import type { Args } from "../args";
import { emit, kv } from "../render";
import { readAuthConfig } from "@/lib/auth/env";
import { bumpSessionGeneration, getSessionGeneration } from "@/lib/auth/generation";

export async function auth(a: Args, json: boolean) {
  const [verb = "status", ...rest] = a._;
  if (rest.length || !["status", "revoke"].includes(verb)) throw new Error("usage: fin auth [status|revoke]");

  if (verb === "revoke") {
    const generation = await bumpSessionGeneration();
    return emit(json, { ok: true, generation }, () => `Signed out every web session (generation ${generation}). Running servers notice within 2 seconds.`);
  }

  const config = readAuthConfig();
  const generation = await getSessionGeneration();
  const state = config.state === "misconfigured" ? `misconfigured: ${config.reason}` : config.state;
  emit(json, { state: config.state, ...(config.state === "misconfigured" ? { reason: config.reason } : {}), generation }, () =>
    kv([
      ["Web sign-in", state],
      ["Session generation", String(generation)],
      ["Note", "reads this shell's env; the server's own env is what counts"],
    ]),
  );
}
