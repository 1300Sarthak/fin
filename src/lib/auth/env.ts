import { parsePasswordHash } from "./password";
import { MIN_SECRET_LENGTH } from "./session";

/**
 * Auth configuration from the environment, read per call (not at import) so a
 * test can pass its own env and a misconfiguration is reported where it bites.
 *
 * - FIN_PASSWORD_HASH   output of `bun run scripts/hash-password.ts`
 * - FIN_SESSION_SECRET  >= 32 random characters; changing it signs everyone out
 * - FIN_COOKIE_SECURE   "1" forces the Secure flag (behind a proxy that speaks
 *                       plain HTTP to the app), "0" forbids it; unset = infer
 * - FIN_ALLOW_NO_AUTH   "loopback" lets a production build run without a
 *                       password, still only for loopback requests
 */
export type Env = Record<string, string | undefined>;

export type AuthConfig =
  | { state: "enabled"; hash: string; secret: string }
  | { state: "disabled" }
  | { state: "misconfigured"; reason: string };

export function readAuthConfig(env: Env = process.env): AuthConfig {
  const hash = env.FIN_PASSWORD_HASH?.trim();
  if (!hash) return { state: "disabled" };
  if (!parsePasswordHash(hash)) return { state: "misconfigured", reason: "FIN_PASSWORD_HASH is not a hash from scripts/hash-password.ts." };
  const secret = env.FIN_SESSION_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return { state: "misconfigured", reason: `FIN_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.` };
  return { state: "enabled", hash, secret };
}

export const authEnabled = (env: Env = process.env) => readAuthConfig(env).state === "enabled";
