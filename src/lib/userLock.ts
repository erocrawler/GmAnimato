/**
 * In-process "one lock per key" async mutex.
 *
 * Why it exists: kickoff / retry do check-then-write on shared state
 * ("is the video already in_queue?", "is today's quota used up?", "is the
 * user's queue full?" -> flip to in_queue and submit). Without mutual exclusion
 * concurrent requests of the same user all read the old state and all pass.
 *
 * ASSUMPTION — single process: production runs one pm2 fork process (no
 * cluster / no second instance), so an in-memory lock is enough. It protects
 * nothing across processes: if the app is ever scaled out to several instances
 * (or pm2 cluster mode), replace this with a database lock (e.g. a
 * transaction-scoped pg_advisory_xact_lock(hashtext(userId)) or a conditional
 * UPDATE ... WHERE status NOT IN ('in_queue','processing')). The lock is also
 * lost on process restart, which is fine: nothing is held across a restart.
 *
 * Semantics:
 *  - calls with the same key run strictly one at a time, in arrival order;
 *    different keys never block each other;
 *  - if fn throws / rejects the lock is released and the error is rethrown to
 *    that caller only;
 *  - a caller that has waited longer than `waitTimeoutMs` gets
 *    UserLockTimeoutError and fn is NOT executed; it leaves the queue without
 *    disturbing anyone else;
 *  - a key with no holder and no waiter is removed from the internal map.
 *
 * Implementation: every key owns a promise chain. A call takes the current
 * tail as "prev", appends its own link `mine`, and the new tail is
 * `prev.then(() => mine)` — it settles only after prev settled AND this call
 * released (or gave up). Links only ever resolve (never reject), so the chain
 * cannot get poisoned by a failing fn. A call that times out resolves `mine`
 * immediately but the tail still waits for `prev`, so the callers queued
 * behind it keep waiting for the real holder (the chain is not shortened).
 * Cleanup uses a per-key count of "holder + waiters" instead of comparing the
 * tail pointer in a promise callback: the count is decremented synchronously
 * when a call finishes/gives up, so the entry is dropped exactly when nobody
 * holds or waits (a new arrival after that starts a fresh chain, which is
 * correct since the old tail is already settled) — no window where a later
 * arrival's tail gets deleted by an earlier call's cleanup.
 */

export const DEFAULT_USER_LOCK_WAIT_MS = 30_000;

export class UserLockTimeoutError extends Error {
  readonly key: string;
  readonly waitedMs: number;
  constructor(key: string, waitedMs: number) {
    super(`timed out after ${waitedMs}ms waiting for the lock of "${key}"`);
    this.name = 'UserLockTimeoutError';
    this.key = key;
    this.waitedMs = waitedMs;
  }
}

type Entry = { tail: Promise<void>; count: number };
const locks = new Map<string, Entry>();

let waitOverrideMs: number | null = null;

/** Test hook: override the default wait timeout (null restores 30s). */
export function __setUserLockTimeoutForTest(ms: number | null): void {
  waitOverrideMs = ms;
}

/** Test hook: number of keys currently tracked (0 when idle). */
export function __userLockSize(): number {
  return locks.size;
}

/** Resolves true when `prev` settles first, false when the timeout wins. */
function waitFor(prev: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (!Number.isFinite(timeoutMs)) return prev.then(() => true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    prev.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function withUserLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { waitTimeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.waitTimeoutMs ?? waitOverrideMs ?? DEFAULT_USER_LOCK_WAIT_MS;

  let entry = locks.get(key);
  const prev: Promise<void> | undefined = entry?.tail;

  // Take our place in line synchronously, before any await: this fixes the
  // arrival order.
  let releaseMine!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseMine = resolve;
  });
  const tail = prev ? prev.then(() => mine) : mine;
  if (entry) {
    entry.tail = tail;
    entry.count++;
  } else {
    entry = { tail, count: 1 };
    locks.set(key, entry);
  }
  const mineEntry = entry;

  const leave = () => {
    releaseMine();
    if (--mineEntry.count === 0 && locks.get(key) === mineEntry) locks.delete(key);
  };

  if (prev) {
    const started = Date.now();
    const acquired = await waitFor(prev, timeoutMs);
    if (!acquired) {
      leave();
      throw new UserLockTimeoutError(key, Date.now() - started);
    }
  }

  try {
    return await fn();
  } finally {
    leave();
  }
}

/** 429 body shared by the routes that take the lock. */
export function userLockBusyResponse(): Response {
  return new Response(
    JSON.stringify({ error: '该用户有请求正在处理,请稍后重试', errorCode: 'busy' }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );
}
