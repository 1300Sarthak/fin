import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless session cookie: `base64url(payload).base64url(HMAC-SHA256)`.
 *
 * The payload carries an absolute expiry and the session generation it was
 * issued under. Bumping the generation (app_config `auth_session_generation`)
 * makes every earlier cookie fail verification — that is "sign out everywhere".
 */
export const SESSION_COOKIE = "fin_session";
export const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
/** A browser-session cookie still gets a hard ceiling, so a copied cookie does not live forever. */
export const SESSION_MS = 24 * 60 * 60 * 1000;
export const MIN_SECRET_LENGTH = 32;

export type SessionPayload = { v: 1; gen: number; iat: number; exp: number; remember: boolean };

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest();

export function createSessionToken(input: { gen: number; remember: boolean; now?: number }, secret: string): { token: string; payload: SessionPayload } {
  const iat = input.now ?? Date.now();
  const payload: SessionPayload = { v: 1, gen: input.gen, iat, exp: iat + (input.remember ? REMEMBER_MS : SESSION_MS), remember: input.remember };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${body}.${sign(body, secret).toString("base64url")}`, payload };
}

/** Signature, shape, and expiry. The generation is compared by the caller, which owns the DB read. */
export function verifySessionToken(token: string | undefined | null, secret: string, now = Date.now()): SessionPayload | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = sign(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || !Number.isSafeInteger(p.gen) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || typeof p.remember !== "boolean") return null;
  if ((p.exp as number) <= now || (p.iat as number) > now + 60_000) return null;
  return p as SessionPayload;
}

export function isValidSession(token: string | undefined | null, secret: string, generation: number, now = Date.now()): boolean {
  const payload = verifySessionToken(token, secret, now);
  return payload !== null && payload.gen === generation;
}
