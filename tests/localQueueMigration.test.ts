import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateOldestEligibleJob, MIGRATION_WRITEBACK_RETRY_DELAYS_MS } from '../src/lib/local-queue';
import { runQueueSweep, type QueueSweepDeps } from '../src/lib/queueSweeper';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const cfg = { endpointUrl: 'http://rp.test', apiKey: 'secret-key' } as any;
const settings = {} as any;
const VIDEO = { id: 'vid-1', job_id: 'local-vid-1-uuid', is_local_job: true } as any;

describe('migrateOldestEligibleJob: submit / write-back failure handling', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const setup = (over: { update?: (id: string, p: any) => Promise<any>; submit?: any; build?: any } = {}) => {
    const sleeps: number[] = [];
    const updates: Array<{ id: string; patch: any }> = [];
    const claim = vi.fn(async () => VIDEO);
    const update = vi.fn(async (id: string, patch: any) => {
      updates.push({ id, patch });
      if (over.update) return over.update(id, patch);
      return {};
    });
    const build = over.build ?? vi.fn(async () => ({ input: {} }));
    const submit = over.submit ?? vi.fn(async () => ({ id: 'rp-job-9' }));
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const run = () => migrateOldestEligibleJob(cfg, settings, claim, update, build, submit, sleep);
    return { run, sleeps, updates, claim, update, build, submit, sleep };
  };

  it('a: submit ok, write-back fails once then succeeds -> true, one submit, final write has dequeued_at: null', async () => {
    let n = 0;
    const t = setup({ update: async () => { if (++n === 1) throw new Error('db blip'); return {}; } });
    expect(await t.run()).toBe(true);
    expect(t.submit).toHaveBeenCalledTimes(1);
    expect(t.updates).toHaveLength(2);
    const last = t.updates[1].patch;
    expect(last).toEqual({ is_local_job: false, job_id: 'rp-job-9', status: 'in_queue', dequeued_at: null });
    expect('dequeued_at' in last && last.dequeued_at === null).toBe(true); // null, not undefined
  });

  it('b: submit ok, write-back fails 3x -> false, NO in_queue reset, one submit, error log has video id + runpod job id', async () => {
    const t = setup({ update: async () => { throw new Error('db down'); } });
    expect(await t.run()).toBe(false);
    expect(t.submit).toHaveBeenCalledTimes(1);
    expect(t.updates).toHaveLength(3); // 3 attempts, nothing else
    for (const u of t.updates) expect(u.patch.is_local_job).toBe(false); // only the write-back patch, never a reset
    expect(t.updates.some((u) => u.patch.status === 'in_queue' && u.patch.is_local_job === undefined)).toBe(false);
    const logged = errSpy.mock.calls.map((c: any[]) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('vid-1');
    expect(logged).toContain('rp-job-9');
    expect(logged).not.toContain('secret-key');
    expect(logged).not.toContain('rp.test');
  });

  it('c: submit throws -> reset to in_queue with dequeued_at: null, false', async () => {
    const t = setup({ submit: vi.fn(async () => { throw new Error('runpod 500'); }) });
    expect(await t.run()).toBe(false);
    expect(t.updates).toEqual([{ id: 'vid-1', patch: { status: 'in_queue', dequeued_at: null } }]);
    expect(t.sleeps).toEqual([]);
  });

  it('d: build throws -> reset to in_queue with dequeued_at: null, false, nothing submitted', async () => {
    const t = setup({ build: vi.fn(async () => { throw new Error('bad workflow'); }) });
    expect(await t.run()).toBe(false);
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.updates).toEqual([{ id: 'vid-1', patch: { status: 'in_queue', dequeued_at: null } }]);
  });

  it('e: retry delays are 200ms then 600ms via the injected sleep (2 calls, no real waiting)', async () => {
    expect(MIGRATION_WRITEBACK_RETRY_DELAYS_MS).toEqual([200, 600]);
    const t = setup({ update: async () => { throw new Error('db down'); } });
    const started = Date.now();
    await t.run();
    expect(Date.now() - started).toBeLessThan(150);
    expect(t.sleep).toHaveBeenCalledTimes(2);
    expect(t.sleeps).toEqual([200, 600]);

    const ok = setup();
    expect(await ok.run()).toBe(true);
    expect(ok.sleep).not.toHaveBeenCalled(); // no delay on first-try success
  });

  it('no claim -> false without touching the DB; no config -> false', async () => {
    const t = setup();
    t.claim.mockResolvedValueOnce(null as any);
    expect(await t.run()).toBe(false);
    expect(t.update).not.toHaveBeenCalled();
    expect(await migrateOldestEligibleJob(null, settings, t.claim, t.update, t.build, t.submit, t.sleep)).toBe(false);
  });

  it('write-back failure that is also followed by a reset-failure-prone DB does not reset (still only 3 writes)', async () => {
    const t = setup({ update: async () => { throw new Error('db down'); } });
    await t.run();
    expect(t.update).toHaveBeenCalledTimes(3);
  });
});

describe('runQueueSweep with a submitted-but-unrecorded job', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts it as failed once, never re-claims it in the same sweep, and issues no in_queue reset', async () => {
    // Fake DB: claimStaleLocalJob flips in_queue -> processing like the real one; updateVideo always fails.
    const rows = [
      { id: 'a', startedAt: 1, status: 'in_queue' },
      { id: 'b', startedAt: 2, status: 'in_queue' },
    ];
    const writes: any[] = [];
    const claimed: string[] = [];
    const deps: QueueSweepDeps = {
      now: () => Date.parse('2026-11-17T10:00:00Z'),
      getAdminSettings: async () => ({ freeUserWaitThresholdMinutes: 30 }) as any,
      failTimedOutProcessing: async () => [],
      claimStaleLocalJob: async (_o: Date, ex: string[] = []) => {
        const hit = rows.find((r) => r.status === 'in_queue' && !ex.includes(r.id));
        if (!hit) return null;
        hit.status = 'processing';
        claimed.push(hit.id);
        return { id: hit.id } as any;
      },
      updateVideo: async (id: string, patch: any) => {
        writes.push({ id, patch });
        throw new Error('db down');
      },
      getRunPodConfig: () => cfg,
      resolveCallbackBase: () => 'https://cb.example.test',
      buildPayload: async () => ({ input: {} }),
      submitRunPodJob: vi.fn(async () => ({ id: 'rp-x' })),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      maxMigrations: 5,
    };
    const p = runQueueSweep(deps);
    await vi.advanceTimersByTimeAsync(10_000);
    const s = await p;
    expect(s.migrated).toBe(0);
    expect(s.migrationFailed).toBe(2); // each row: one failed migration
    expect(claimed).toEqual(['a', 'b']); // each claimed exactly once
    expect(deps.submitRunPodJob).toHaveBeenCalledTimes(2);
    expect(writes.every((w) => w.patch.status === 'in_queue' && w.patch.is_local_job === false)).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(['processing', 'processing']); // left for the timeout sweep
  });
});
