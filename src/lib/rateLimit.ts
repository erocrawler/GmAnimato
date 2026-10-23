/**
 * Tiny in-memory token-bucket limiter (single Node process; state is lost on
 * restart, which only ever makes limits more lenient for a minute).
 */

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

type Bucket = { tokens: number; updatedAt: number };

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private calls = 0;
  /** refill rate in tokens/ms */
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    windowMs: number,
    private readonly now: () => number = Date.now
  ) {
    this.refillPerMs = capacity / windowMs;
  }

  consume(key: string): RateLimitResult {
    const t = this.now();
    this.maybeSweep(t);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.updatedAt) * this.refillPerMs);
    b.updatedAt = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { allowed: true };
    }
    this.buckets.set(key, b);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / this.refillPerMs / 1000)) };
  }

  /** Drop buckets that have fully refilled (they are indistinguishable from new ones). */
  private maybeSweep(t: number) {
    if (++this.calls % 500 !== 0) return;
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(k);
    }
  }

  get size() {
    return this.buckets.size;
  }
}

export const PAT_GENERAL_LIMIT_PER_MINUTE = 60;
export const PAT_HEAVY_LIMIT_PER_MINUTE = 10;

/** Per-token limits: 60 req/min overall, 10/min for uploads and kickoff. */
export class TokenRateLimiter {
  private general: TokenBucketLimiter;
  private heavy: TokenBucketLimiter;

  constructor(now: () => number = Date.now) {
    this.general = new TokenBucketLimiter(PAT_GENERAL_LIMIT_PER_MINUTE, 60_000, now);
    this.heavy = new TokenBucketLimiter(PAT_HEAVY_LIMIT_PER_MINUTE, 60_000, now);
  }

  check(tokenId: string, heavyRoute: boolean): RateLimitResult {
    const g = this.general.consume(tokenId);
    if (!g.allowed) return g;
    return heavyRoute ? this.heavy.consume(tokenId) : g;
  }
}

export const patRateLimiter = new TokenRateLimiter();

/**
 * Failed-login lockout: after `maxFailures` failures within `lockMs` for a key
 * (IP + username) further attempts are refused until the lock expires.
 */
export class FailureLockout {
  private entries = new Map<string, { failures: number; lockedUntil: number; lastAt: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly lockMs = 5 * 60_000,
    private readonly now: () => number = Date.now
  ) {}

  /** Seconds the caller must still wait, or 0 when attempts are allowed. */
  lockedFor(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const t = this.now();
    if (e.lockedUntil > t) return Math.ceil((e.lockedUntil - t) / 1000);
    // Stale failure counts decay after the same window.
    if (t - e.lastAt > this.lockMs) this.entries.delete(key);
    return 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0, lastAt: t };
    if (e.lockedUntil <= t && t - e.lastAt > this.lockMs) e.failures = 0;
    e.failures += 1;
    e.lastAt = t;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = t + this.lockMs;
      e.failures = 0;
    }
    this.entries.set(key, e);
    if (this.entries.size > 10_000) this.sweep(t);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private sweep(t: number) {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= t && t - e.lastAt > this.lockMs) this.entries.delete(k);
    }
  }
}

export const loginLockout = new FailureLockout();

/** Password login / register attempts: 10 per minute per client address + username. */
export const AUTH_LIMIT_PER_MINUTE = 10;
export const authRateLimiter = new TokenBucketLimiter(AUTH_LIMIT_PER_MINUTE, 60_000);
