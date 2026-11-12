import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Owner password hashing with scrypt from node:crypto, so there is no native
 * dependency to build in the container.
 *
 * Encoded as `scrypt:<log2 N>:<r>:<p>:<salt>:<hash>` with base64url parts. No `$`
 * on purpose: Docker Compose interpolates `$` inside env files, which would
 * silently corrupt a PHC-style string pasted into `fin/.env`.
 */
const LOG2_N = 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
export const MAX_PASSWORD_LENGTH = 1024;

type Params = { log2n: number; r: number; p: number; salt: Buffer; hash: Buffer };

function derive(password: string, salt: Buffer, log2n: number, r: number, p: number, bytes: number): Promise<Buffer> {
  const N = 2 ** log2n;
  // scrypt needs 128 * N * r bytes; the default 32 MiB ceiling is exactly N=2^15, r=8, so give headroom.
  const maxmem = 256 * N * r;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, bytes, { N, r, p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Strict parse, with bounds so a malformed env value cannot ask for gigabytes of memory. */
export function parsePasswordHash(encoded: string): Params | null {
  const parts = encoded.trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [log2n, r, p] = parts.slice(1, 4).map((part) => (/^\d{1,2}$/.test(part) ? Number(part) : NaN));
  if (!(log2n >= 14 && log2n <= 20) || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) return null;
  const b64 = /^[A-Za-z0-9_-]+$/;
  if (!b64.test(parts[4]) || !b64.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (salt.length < 16 || hash.length < 32 || hash.length > 64) return null;
  return { log2n, r, p, salt, hash };
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) throw new Error(`Password must be 1-${MAX_PASSWORD_LENGTH} characters.`);
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, LOG2_N, R, P, KEY_BYTES);
  return ["scrypt", LOG2_N, R, P, salt.toString("base64url"), hash.toString("base64url")].join(":");
}

/** Constant-time on the derived key; false (never a throw) for a malformed hash or an oversized password. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const params = parsePasswordHash(encoded);
  if (!params || typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  const key = await derive(password, params.salt, params.log2n, params.r, params.p, params.hash.length);
  return timingSafeEqual(key, params.hash);
}
