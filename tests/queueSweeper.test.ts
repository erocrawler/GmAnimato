import { describe, expect, it, vi } from 'vitest';
import { MAX_MIGRATIONS_PER_SWEEP, runQueueSweep, type QueueSweepDeps } from '../src/lib/queueSweeper';
import { PROCESSING_TIMEOUT_MS } from '../src/lib/runpod';
import { isQueueSweepDisabled, resolveCallbackBase } from '../src/lib/queueSweeperRuntime';

// queueSweeperRuntime imports the real wiring modules; stub the ones that need a database/env.
vi.mock('$lib/db', () => ({
  getAdminSettings: vi.fn(),
  updateVideo: vi.fn(),
  claimStaleLocalJob: vi.fn(),
  failTimedOutProcessing: vi.fn(),
}));
vi.mock('$lib/jobWorkflow', () => ({ buildJobWorkflow: vi.fn(), getCallbackUrl: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const silent = { log: () => {}, warn: () => {}, error: () => {} };
const cfg = { endpointUrl: 'http://rp.test', apiKey: 'k' };

/**
 * Fake queue: each entry is a stale local in_queue job. claimStaleLocalJob hands out the oldest one
 * older than the cutoff that is not excluded, flipping it to 'processing' like the real DB does.
 */
function makeFake(opts: {
  jobs?: Array<{ id: string; startedAt: number; local?: boolean; status?: string }>;
  settings?: any;
  timedOut?: string[];
  config?: any;
  base?: string | null;
  submit?: (cfg: any, payload: any) => Promise<{ id: string }>;
  build?: (v: any) => Promise<any>;
} = {}) {
  const rows = (opts.jobs ?? []).map((j) => ({
    id: j.id, startedAt: j.startedAt, is_local_job: j.local ?? true, status: j.status ?? 'in_queue', job_id: `local-${j.id}`,
  }));
  const claimArgs: Array<{ olderThan: Date; excludeIds?: string[] }> = [];
  const updates: Array<{ id: string; patch: any }> = [];
  const deps: QueueSweepDeps = {
    now: () => NOW,
    getAdminSettings: vi.fn(async () => opts.settings ?? { freeUserWaitThresholdMinutes: 30 }),
    failTimedOutProcessing: vi.fn(async () => opts.timedOut ?? []),
    claimStaleLocalJob: vi.fn(async (olderThan: Date, excludeIds: string[] = []) => {
      claimArgs.push({ olderThan, excludeIds: [...excludeIds] });
      const hit = rows
        .filter((r) => r.is_local_job && r.status === 'in_queue' && r.startedAt < olderThan.getTime() && !excludeIds.includes(r.id))
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!hit) return null;
      hit.status = 'processing';
      return { id: hit.id } as any;
    }),
    updateVideo: vi.fn(async (id: string, patch: any) => {
      updates.push({ id, patch });
      const r = rows.find((x) => x.id === id)!;
      if (patch.status) r.status = patch.status;
      if (patch.is_local_job !== undefined) r.is_local_job = patch.is_local_job;
      if (patch.job_id) r.job_id = patch.job_id;
      return r;
    }),
    getRunPodConfig: () => ('config' in opts ? opts.config : cfg),
    resolveCallbackBase: () => ('base' in opts ? (opts.base as any) : 'https://cb.example.test'),
    buildPayload: vi.fn(opts.build ?? (async (v: any) => ({ input: { id: v.id } }))),
    submitRunPodJob: vi.fn(opts.submit ?? (async (_c: any, p: any) => ({ id: `rp-${p.input.id}` }))),
    logger: silent,
  };
  return { rows, deps, claimArgs, updates };
}

const min = (m: number) => m * 60 * 1000;

describe('runQueueSweep: processing timeouts', () => {
  it('asks the DB to fail jobs older than PROCESSING_TIMEOUT_MS and reports the count', async () => {
    const f = makeFake({ timedOut: ['a', 'b', 'c'] });
    const s = await runQueueSweep(f.deps);
    expect(s.timedOut).toBe(3);
    expect(s.timedOutIds).toEqual(['a', 'b', 'c']);
    const cutoff = (f.deps.failTimedOutProcessing as any).mock.calls[0][0] as Date;
    expect(cutoff.getTime()).toBe(NOW - PROCESSING_TIMEOUT_MS);
  });

  it('a failing timeout step is logged but migration still runs', async () => {
    const f = makeFake({ jobs: [{ id: 'x', startedAt: NOW - min(45) }] });
    (f.deps.failTimedOutProcessing as any).mockRejectedValueOnce(new Error('db down'));
    const s = await runQueueSweep(f.deps);
    expect(s.timedOut).toBe(0);
    expect(s.errors[0]).toContain('timeout: db down');
    expect(s.migrated).toBe(1);
  });
});

describe('runQueueSweep: migration', () => {
  it('migrates only jobs waiting longer than the threshold (settings value, default 30)', async () => {
    const f = makeFake({
      jobs: [
        { id: 'old1', startedAt: NOW - min(90) },
        { id: 'old2', startedAt: NOW - min(31) },
        { id: 'fresh', startedAt: NOW - min(29) },
      ],
    });
    const s = await runQueueSweep(f.deps);
    expect(s.migrated).toBe(2);
    expect(s.migratedIds).toEqual(['old1', 'old2']);
    expect(f.rows.find((r) => r.id === 'fresh')!.status).toBe('in_queue');
    expect(f.claimArgs[0].olderThan.getTime()).toBe(NOW - min(30));

    const g = makeFake({ jobs: [{ id: 'j', startedAt: NOW - min(45) }], settings: { freeUserWaitThresholdMinutes: 60 } });
    expect((await runQueueSweep(g.deps)).migrated).toBe(0);
    expect(g.claimArgs[0].olderThan.getTime()).toBe(NOW - min(60));

    const h = makeFake({ jobs: [{ id: 'j', startedAt: NOW - min(31) }], settings: {} }); // missing => 30
    expect((await runQueueSweep(h.deps)).migrated).toBe(1);
  });

  it('writes the same fields as the submitJob migration branch, and clears dequeued_at with null', async () => {
    const f = makeFake({ jobs: [{ id: 'v1', startedAt: NOW - min(40) }] });
    await runQueueSweep(f.deps);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].patch).toEqual({ is_local_job: false, job_id: 'rp-v1', status: 'in_queue', dequeued_at: null });
    expect(f.deps.buildPayload).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }), expect.anything(), 'https://cb.example.test');
  });

  it('migrates at most 20 per sweep', async () => {
    const jobs = Array.from({ length: 27 }, (_, i) => ({ id: `j${i}`, startedAt: NOW - min(100) + i }));
    const f = makeFake({ jobs });
    const s = await runQueueSweep(f.deps);
    expect(MAX_MIGRATIONS_PER_SWEEP).toBe(20);
    expect(s.migrated).toBe(20);
    expect(f.rows.filter((r) => r.is_local_job)).toHaveLength(7);
  });

  it('a submit failure resets the job to in_queue and the next-oldest job is still migrated', async () => {
    const f = makeFake({
      jobs: [
        { id: 'bad', startedAt: NOW - min(100) },
        { id: 'good', startedAt: NOW - min(90) },
      ],
      submit: async (_c, p) => {
        if (p.input.id === 'bad') throw new Error('runpod 500');
        return { id: 'rp-good' };
      },
    });
    const s = await runQueueSweep(f.deps);
    expect(s.migrated).toBe(1);
    expect(s.migratedIds).toEqual(['good']);
    expect(s.migrationFailed).toBe(1);
    const bad = f.rows.find((r) => r.id === 'bad')!;
    expect(bad.status).toBe('in_queue');
    expect(bad.is_local_job).toBe(true);
    expect(bad.job_id).toBe('local-bad');
    // the failed row is excluded from later claims in the same sweep (no hot loop on it)
    expect(f.claimArgs.some((c) => c.excludeIds?.includes('bad'))).toBe(true);
    expect(f.updates.find((u) => u.id === 'bad')!.patch).toEqual({ status: 'in_queue', dequeued_at: null });
  });

  it('a payload build failure also resets and continues', async () => {
    const f = makeFake({
      jobs: [{ id: 'a', startedAt: NOW - min(100) }, { id: 'b', startedAt: NOW - min(99) }],
      build: async (v) => { if (v.id === 'a') throw new Error('no workflow'); return { input: { id: v.id } }; },
    });
    const s = await runQueueSweep(f.deps);
    expect(s.migrated).toBe(1);
    expect(s.migrationFailed).toBe(1);
    expect(f.rows.find((r) => r.id === 'a')!.status).toBe('in_queue');
  });

  it('a claim error does not abort the batch; repeated claim errors stop it', async () => {
    const f = makeFake({ jobs: [{ id: 'a', startedAt: NOW - min(100) }] });
    (f.deps.claimStaleLocalJob as any).mockRejectedValueOnce(new Error('deadlock'));
    const s = await runQueueSweep(f.deps);
    expect(s.migrated).toBe(1);
    expect(s.errors).toContain('claim: deadlock');

    const g = makeFake({ jobs: [{ id: 'a', startedAt: NOW - min(100) }] });
    (g.deps.claimStaleLocalJob as any).mockRejectedValue(new Error('db down'));
    const s2 = await runQueueSweep(g.deps);
    expect(s2.migrated).toBe(0);
    expect(g.deps.claimStaleLocalJob).toHaveBeenCalledTimes(3);
  });

  it('a failing reset after a failed submit does not throw out of the sweep', async () => {
    const f = makeFake({
      jobs: [{ id: 'a', startedAt: NOW - min(100) }],
      submit: async () => { throw new Error('boom'); },
    });
    (f.deps.updateVideo as any).mockRejectedValue(new Error('db gone'));
    const s = await runQueueSweep(f.deps);
    expect(s.migrated).toBe(0);
    expect(s.migrationFailed).toBe(1);
  });

  it('RunPod not configured: only the timeout sweep runs', async () => {
    const f = makeFake({ jobs: [{ id: 'a', startedAt: NOW - min(100) }], timedOut: ['t1'], config: null });
    const s = await runQueueSweep(f.deps);
    expect(s).toMatchObject({ timedOut: 1, migrated: 0, skipped: 'runpod-not-configured' });
    expect(f.deps.claimStaleLocalJob).not.toHaveBeenCalled();
    expect(f.deps.submitRunPodJob).not.toHaveBeenCalled();
  });

  it('no reliable callback base: only the timeout sweep runs', async () => {
    const f = makeFake({ jobs: [{ id: 'a', startedAt: NOW - min(100) }], timedOut: ['t1', 't2'], base: null });
    const s = await runQueueSweep(f.deps);
    expect(s).toMatchObject({ timedOut: 2, migrated: 0, skipped: 'no-callback-base' });
    expect(f.deps.claimStaleLocalJob).not.toHaveBeenCalled();
    expect(f.deps.submitRunPodJob).not.toHaveBeenCalled();
  });
});

describe('runQueueSweep: re-entrancy', () => {
  it('a second sweep while one is running is skipped, and the flag is released afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = makeFake();
    (f.deps.failTimedOutProcessing as any).mockImplementationOnce(async () => { await gate; return []; });

    const first = runQueueSweep(f.deps);
    const second = await runQueueSweep(makeFake().deps);
    expect(second.skipped).toBe('already-running');
    expect(second.migrated + second.timedOut).toBe(0);

    release();
    await first;
    const third = await runQueueSweep(makeFake().deps);
    expect(third.skipped).not.toBe('already-running');
  });

  it('the flag is released even when everything throws', async () => {
    const f = makeFake();
    (f.deps.failTimedOutProcessing as any).mockRejectedValue(new Error('x'));
    (f.deps.getAdminSettings as any).mockRejectedValue(new Error('y'));
    const s = await runQueueSweep(f.deps);
    expect(s.errors).toHaveLength(2);
    expect((await runQueueSweep(makeFake().deps)).skipped).not.toBe('already-running');
  });
});

describe('runtime helpers', () => {
  it('QUEUE_SWEEP_DISABLED switch (default on)', () => {
    expect(isQueueSweepDisabled({})).toBe(false);
    expect(isQueueSweepDisabled({ QUEUE_SWEEP_DISABLED: '' })).toBe(false);
    expect(isQueueSweepDisabled({ QUEUE_SWEEP_DISABLED: '0' })).toBe(false);
    expect(isQueueSweepDisabled({ QUEUE_SWEEP_DISABLED: '1' })).toBe(true);
    expect(isQueueSweepDisabled({ QUEUE_SWEEP_DISABLED: 'true' })).toBe(true);
  });

  it('callback base: CALLBACK_BASE_URL, else ORIGIN; loopback/invalid => null (never guessed)', () => {
    expect(resolveCallbackBase({})).toBeNull();
    expect(resolveCallbackBase({ CALLBACK_BASE_URL: 'https://a.example.test/' })).toBe('https://a.example.test');
    expect(resolveCallbackBase({ ORIGIN: 'https://o.example.test' })).toBe('https://o.example.test');
    expect(resolveCallbackBase({ CALLBACK_BASE_URL: 'https://a.example.test', ORIGIN: 'https://o.example.test' })).toBe('https://a.example.test');
    expect(resolveCallbackBase({ CALLBACK_BASE_URL: 'http://localhost:5173' })).toBeNull();
    expect(resolveCallbackBase({ CALLBACK_BASE_URL: 'http://localhost:5173', ORIGIN: 'https://o.example.test' })).toBeNull();
    expect(resolveCallbackBase({ ORIGIN: 'http://127.0.0.1:3000' })).toBeNull();
    expect(resolveCallbackBase({ ORIGIN: 'http://[::1]:3000' })).toBeNull();
    expect(resolveCallbackBase({ ORIGIN: 'not a url' })).toBeNull();
    expect(resolveCallbackBase({ ORIGIN: 'ftp://x.example.test' })).toBeNull();
  });
});
