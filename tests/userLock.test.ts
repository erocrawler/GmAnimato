import { afterEach, describe, expect, it } from 'vitest';
import {
  withUserLock,
  UserLockTimeoutError,
  __userLockSize,
  __setUserLockTimeoutForTest,
  DEFAULT_USER_LOCK_WAIT_MS,
  userLockBusyResponse,
} from '../src/lib/userLock';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => __setUserLockTimeoutForTest(null));

describe('withUserLock', () => {
  it('same key: strictly serial, in arrival order, no overlap', async () => {
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string, ms: number) => () =>
      (async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start ${name}`);
        await sleep(ms);
        log.push(`end ${name}`);
        running--;
        return name;
      })();

    // later arrivals are shorter: a non-FIFO lock would reorder them
    const results = await Promise.all([
      withUserLock('u1', task('a', 30)),
      withUserLock('u1', task('b', 10)),
      withUserLock('u1', task('c', 1)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('different keys run in parallel', async () => {
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`start ${name}`);
      await sleep(30);
      log.push(`end ${name}`);
    };
    await Promise.all([withUserLock('a', task('a')), withUserLock('b', task('b'))]);
    // both started before either ended
    expect(log.slice(0, 2).sort()).toEqual(['start a', 'start b']);
  });

  it('a slow holder on one key does not delay another key', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const a = withUserLock('a', () => gateA);
    const bResult = await withUserLock('b', async () => 'b-done');
    expect(bResult).toBe('b-done');
    releaseA();
    await a;
  });

  it('fn throwing releases the lock, the error is rethrown unchanged, later callers run', async () => {
    const boom = new Error('boom');
    const order: string[] = [];
    const p1 = withUserLock('u', async () => {
      order.push('1');
      throw boom;
    });
    const p2 = withUserLock('u', async () => {
      order.push('2');
      return 'ok';
    });
    await expect(p1).rejects.toBe(boom);
    await expect(p2).resolves.toBe('ok');
    expect(order).toEqual(['1', '2']);
    // non-Error rejections are passed through too
    await expect(withUserLock('u', () => Promise.reject('plain'))).rejects.toBe('plain');
    // and a synchronous throw inside fn
    await expect(withUserLock('u', (() => {
      throw new Error('sync');
    }) as any)).rejects.toThrow('sync');
    await expect(withUserLock('u', async () => 'still works')).resolves.toBe('still works');
    await flush();
    expect(__userLockSize()).toBe(0);
  });

  it('wait timeout: UserLockTimeoutError, fn not run, queue behind the timed-out caller intact', async () => {
    let releaseHolder!: () => void;
    const holder = withUserLock('u', () => new Promise<void>((r) => (releaseHolder = r)));
    let timedOutRan = false;
    const timedOut = withUserLock(
      'u',
      async () => {
        timedOutRan = true;
      },
      { waitTimeoutMs: 20 },
    );
    const order: string[] = [];
    // queued BEHIND the soon-to-time-out caller, patient
    const after = withUserLock('u', async () => {
      order.push('after');
      return 'after';
    });

    const err = await timedOut.catch((e) => e);
    expect(err).toBeInstanceOf(UserLockTimeoutError);
    expect(err.name).toBe('UserLockTimeoutError');
    expect(err.key).toBe('u');
    expect(timedOutRan).toBe(false);

    // the holder still holds: the caller behind the timed-out one must NOT have jumped the queue
    await sleep(30);
    expect(order).toEqual([]);

    releaseHolder();
    await holder;
    await expect(after).resolves.toBe('after');
    expect(timedOutRan).toBe(false);

    // the key is usable again and nobody mistakes the timed-out caller for a holder
    await expect(withUserLock('u', async () => 'fresh', { waitTimeoutMs: 20 })).resolves.toBe('fresh');
    await flush();
    expect(__userLockSize()).toBe(0);
  });

  it('timeouts do not shorten the chain: several timed-out waiters in the middle', async () => {
    let releaseHolder!: () => void;
    const holder = withUserLock('u', () => new Promise<void>((r) => (releaseHolder = r)));
    const t1 = withUserLock('u', async () => 'x', { waitTimeoutMs: 10 }).catch((e) => e);
    const t2 = withUserLock('u', async () => 'y', { waitTimeoutMs: 25 }).catch((e) => e);
    const ran: string[] = [];
    const last = withUserLock('u', async () => {
      ran.push('last');
    });
    expect(await t1).toBeInstanceOf(UserLockTimeoutError);
    expect(await t2).toBeInstanceOf(UserLockTimeoutError);
    expect(ran).toEqual([]); // holder still holds
    releaseHolder();
    await holder;
    await last;
    expect(ran).toEqual(['last']);
    await flush();
    expect(__userLockSize()).toBe(0);
  });

  it('a caller that is first in line (nobody holds) never times out, even with waitTimeoutMs 0', async () => {
    await expect(withUserLock('free', async () => 1, { waitTimeoutMs: 0 })).resolves.toBe(1);
  });

  it('timeout of a waiter does not count the holder\'s runtime against callers that arrive later', async () => {
    let releaseHolder!: () => void;
    const holder = withUserLock('u', () => new Promise<void>((r) => (releaseHolder = r)));
    const w = withUserLock('u', async () => 'w', { waitTimeoutMs: 200 });
    await sleep(30);
    releaseHolder();
    await holder;
    await expect(w).resolves.toBe('w');
  });

  it('default timeout override (test hook) applies to calls without opts; opts win', async () => {
    expect(DEFAULT_USER_LOCK_WAIT_MS).toBe(30_000);
    __setUserLockTimeoutForTest(15);
    let release!: () => void;
    const holder = withUserLock('u', () => new Promise<void>((r) => (release = r)));
    await expect(withUserLock('u', async () => 'x')).rejects.toBeInstanceOf(UserLockTimeoutError);
    // explicit opts override the hook
    const patient = withUserLock('u', async () => 'patient', { waitTimeoutMs: 500 });
    await sleep(40);
    release();
    await holder;
    await expect(patient).resolves.toBe('patient');
  });

  it('map is cleaned up: all done, with timeouts and errors mixed in', async () => {
    expect(__userLockSize()).toBe(0);
    let release!: () => void;
    const ps = [
      withUserLock('k1', () => new Promise<void>((r) => (release = r))),
      withUserLock('k1', async () => {
        throw new Error('e');
      }).catch(() => 'err'),
      withUserLock('k1', async () => 1, { waitTimeoutMs: 5 }).catch(() => 'timeout'),
      withUserLock('k2', async () => 2),
      withUserLock('k3', async () => {
        throw new Error('e3');
      }).catch(() => 'err'),
    ];
    expect(__userLockSize()).toBeGreaterThanOrEqual(1);
    await sleep(20);
    release();
    await Promise.all(ps);
    await flush();
    expect(__userLockSize()).toBe(0);
  });

  it('a key is dropped while idle and re-created cleanly on the next call', async () => {
    await withUserLock('r', async () => 1);
    await flush();
    expect(__userLockSize()).toBe(0);
    await withUserLock('r', async () => 2);
    await flush();
    expect(__userLockSize()).toBe(0);
  });

  it('200 concurrent callers on one key: arrival order, never overlapping, no deadlock', async () => {
    const N = 200;
    const order: number[] = [];
    let running = 0;
    let overlap = false;
    const ps = Array.from({ length: N }, (_, i) =>
      withUserLock('hot', async () => {
        if (++running > 1) overlap = true;
        // alternate sync-ish and timer-based awaits
        if (i % 7 === 0) await sleep(1);
        else await Promise.resolve();
        order.push(i);
        running--;
        return i;
      }),
    );
    const out = await Promise.all(ps);
    expect(out).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(overlap).toBe(false);
    await flush();
    expect(__userLockSize()).toBe(0);
  });

  it('many keys interleaved: each key keeps its own order', async () => {
    const seen: Record<string, number[]> = {};
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const key = `k${i % 5}`;
      ps.push(
        withUserLock(key, async () => {
          await sleep(0);
          (seen[key] ||= []).push(i);
        }),
      );
    }
    await Promise.all(ps);
    for (const [key, list] of Object.entries(seen)) {
      expect(list, key).toEqual([...list].sort((a, b) => a - b));
      expect(list).toHaveLength(12);
    }
    await flush();
    expect(__userLockSize()).toBe(0);
  });
});

describe('userLockBusyResponse', () => {
  it('is a 429 with errorCode busy', async () => {
    const res = userLockBusyResponse();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.errorCode).toBe('busy');
    expect(typeof body.error).toBe('string');
  });
});
