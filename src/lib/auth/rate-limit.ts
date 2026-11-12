/**
 * In-memory login throttle: per client key plus one global bucket, each with
 * exponential backoff once its free failures are spent. Memory only — a
 * restart forgets it, which is acceptable for a single-owner app behind a
 * tailnet, and there is one server process to remember it in.
 *
 * The global bucket caps total guessing even if per-client keys rotate. Its
 * ceiling is short (one minute) so an attacker cannot lock the owner out for long.
 */
type Bucket = { failures: number; blockedUntil: number; last: number };
export type LimitOptions = { freeFailures: number; baseMs: number; maxMs: number };
export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

export const PER_CLIENT: LimitOptions = { freeFailures: 5, baseMs: 1_000, maxMs: 15 * 60_000 };
export const GLOBAL: LimitOptions = { freeFailures: 20, baseMs: 1_000, maxMs: 60_000 };
/** A bucket quiet this long starts over. */
const IDLE_RESET_MS = 60 * 60_000;
const MAX_KEYS = 5_000;

export class LoginLimiter {
  private clients = new Map<string, Bucket>();
  private global: Bucket = { failures: 0, blockedUntil: 0, last: 0 };

  constructor(private perClient: LimitOptions = PER_CLIENT, private overall: LimitOptions = GLOBAL) {}

  private fresh(bucket: Bucket | undefined, now: number): Bucket {
    return !bucket || now - bucket.last > IDLE_RESET_MS ? { failures: 0, blockedUntil: 0, last: now } : bucket;
  }

  check(key: string, now = Date.now()): Verdict {
    const wait = Math.max(this.fresh(this.clients.get(key), now).blockedUntil, this.fresh(this.global, now).blockedUntil) - now;
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  fail(key: string, now = Date.now()): void {
    const client = this.bump(this.fresh(this.clients.get(key), now), this.perClient, now);
    this.clients.delete(key); // re-insert so Map order is least-recently-failed first
    this.clients.set(key, client);
    this.global = this.bump(this.fresh(this.global, now), this.overall, now);
    while (this.clients.size > MAX_KEYS) this.clients.delete(this.clients.keys().next().value!);
  }

  /**
   * Check and record in one synchronous step, before the slow password hash.
   * Recording only after scrypt let N parallel guesses all pass `check` first.
   */
  attempt(key: string, now = Date.now()): Verdict {
    const verdict = this.check(key, now);
    if (verdict.ok) this.fail(key, now);
    return verdict;
  }

  /** A correct password clears that client's record and refunds its global slot. */
  succeed(key: string): void {
    this.clients.delete(key);
    if (this.global.failures > 0) this.global = { ...this.global, failures: this.global.failures - 1 };
  }

  private bump(bucket: Bucket, options: LimitOptions, now: number): Bucket {
    const failures = bucket.failures + 1;
    const over = failures - options.freeFailures;
    const delay = over > 0 ? Math.min(options.maxMs, options.baseMs * 2 ** Math.min(over - 1, 30)) : 0;
    return { failures, blockedUntil: delay ? now + delay : bucket.blockedUntil, last: now };
  }
}

/** One limiter per server process, kept across dev hot reloads. */
const holder = globalThis as unknown as { __finLoginLimiter?: LoginLimiter };
export const loginLimiter = holder.__finLoginLimiter ??= new LoginLimiter();
