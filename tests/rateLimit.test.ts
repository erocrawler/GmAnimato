import { describe, expect, it } from 'vitest';
import { FailureLockout, TokenBucketLimiter, TokenRateLimiter } from '../src/lib/rateLimit';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TokenBucketLimiter', () => {
  it('allows `capacity` requests then rejects with Retry-After, and refills over time', () => {
    const c = clock();
    const l = new TokenBucketLimiter(3, 60_000, c.now);
    expect(l.consume('k').allowed).toBe(true);
    expect(l.consume('k').allowed).toBe(true);
    expect(l.consume('k').allowed).toBe(true);
    const denied = l.consume('k');
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    c.advance(20_000); // 1 token refilled (3 per 60s)
    expect(l.consume('k').allowed).toBe(true);
    expect(l.consume('k').allowed).toBe(false);
  });

  it('keeps keys independent', () => {
    const c = clock();
    const l = new TokenBucketLimiter(1, 60_000, c.now);
    expect(l.consume('a').allowed).toBe(true);
    expect(l.consume('a').allowed).toBe(false);
    expect(l.consume('b').allowed).toBe(true);
  });
});

describe('TokenRateLimiter (per PAT)', () => {
  it('limits to 60 requests per minute overall', () => {
    const c = clock();
    const l = new TokenRateLimiter(c.now);
    for (let i = 0; i < 60; i++) expect(l.check('t1', false).allowed).toBe(true);
    const r = l.check('t1', false);
    expect(r.allowed).toBe(false);
    expect(l.check('t2', false).allowed).toBe(true); // other tokens unaffected
    c.advance(60_000);
    expect(l.check('t1', false).allowed).toBe(true);
  });

  it('limits uploads/kickoff (heavy) to 10 per minute while normal calls continue', () => {
    const c = clock();
    const l = new TokenRateLimiter(c.now);
    for (let i = 0; i < 10; i++) expect(l.check('t1', true).allowed).toBe(true);
    const r = l.check('t1', true);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(l.check('t1', false).allowed).toBe(true);
  });
});

describe('FailureLockout (login)', () => {
  it('locks for 5 minutes after 5 failures, then releases', () => {
    const c = clock();
    const l = new FailureLockout(5, 5 * 60_000, c.now);
    for (let i = 0; i < 4; i++) {
      l.recordFailure('ip|bob');
      expect(l.lockedFor('ip|bob')).toBe(0);
    }
    l.recordFailure('ip|bob');
    expect(l.lockedFor('ip|bob')).toBe(300);
    expect(l.lockedFor('other-ip|bob')).toBe(0);
    c.advance(299_000);
    expect(l.lockedFor('ip|bob')).toBeGreaterThan(0);
    c.advance(2_000);
    expect(l.lockedFor('ip|bob')).toBe(0);
  });

  it('success clears the counter', () => {
    const c = clock();
    const l = new FailureLockout(5, 5 * 60_000, c.now);
    for (let i = 0; i < 4; i++) l.recordFailure('k');
    l.recordSuccess('k');
    l.recordFailure('k');
    expect(l.lockedFor('k')).toBe(0);
  });

  it('old failures decay after the window', () => {
    const c = clock();
    const l = new FailureLockout(5, 5 * 60_000, c.now);
    for (let i = 0; i < 4; i++) l.recordFailure('k');
    c.advance(6 * 60_000);
    l.recordFailure('k');
    expect(l.lockedFor('k')).toBe(0);
  });
});
