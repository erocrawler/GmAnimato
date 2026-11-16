/**
 * Integration tests against a REAL PostgreSQL (real PostgresDatabase + real $lib/db
 * + real route handlers). Only external side effects are mocked: RunPod, S3,
 * image recognition, workflow-payload construction and `$env/dynamic/private`.
 *
 * Skipped automatically unless PG_TEST_URL is set, so the default
 * `npx vitest run` is unaffected.
 *
 * Run (throw-away container, loopback only; never point this at a real database —
 * the suite TRUNCATEs users/videos/workflows on every test, and refuses to run
 * against a non-loopback host):
 *
 *   docker run -d --name gmanimato-pgtest -e POSTGRES_PASSWORD=test -e POSTGRES_DB=animato \
 *     -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/animato npx prisma migrate deploy
 *   PG_TEST_URL=postgresql://postgres:test@127.0.0.1:55432/animato npx vitest run tests/pg
 *   docker rm -f gmanimato-pgtest
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PG_URL = process.env.PG_TEST_URL;

const h = vi.hoisted(() => ({
  runpod: { submit: null as any, retry: null as any, status: null as any } as Record<'submit' | 'retry' | 'status', any>,
}));

vi.mock('$env/dynamic/private', () => ({
  env: { DATABASE_PROVIDER: 'postgres', DATABASE_URL: process.env.PG_TEST_URL },
}));
vi.mock('$lib/runpod', () => ({
  getRunPodConfig: () => ({ url: 'http://runpod.test', key: 'k' }),
  getRunPodHealth: async () => ({ jobs: { inQueue: 0 } }),
  getRunPodJobStatus: (...a: any[]) => h.runpod.status(...a),
  mapRunPodStatus: (s: string) =>
    ({ FAILED: 'failed', COMPLETED: 'completed', IN_QUEUE: 'in_queue', IN_PROGRESS: 'processing' } as any)[s] ?? 'failed',
  retryRunPodJob: (...a: any[]) => h.runpod.retry(...a),
  submitRunPodJob: (...a: any[]) => h.runpod.submit(...a),
}));
vi.mock('$lib/jobWorkflow', () => ({
  buildJobWorkflow: async () => ({ payload: { input: {} } }),
  getCallbackUrl: (origin: string, id: string) => `${origin}/api/i2v-webhook/${id}`,
}));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => 'https://s3.test/x.mp4' }));
vi.mock('$lib/serverImageUrl', () => ({ toOriginalUrl: (u: string) => u, toProxiedUrl: (u: string) => u }));
vi.mock('$lib/ref2vPoster', () => ({ extractRef2VPosterFromResult: async () => null }));
vi.mock('$lib/imageRecognition', () => ({ evaluatePromptProperties: async () => ({}) }));

describe.skipIf(!PG_URL)('real Postgres integration', () => {
  let db: any; // real $lib/db module (delegates to a real PostgresDatabase)
  let prisma: any;
  let retry: any, reopen: any, webhook: any, kickoff: any, submitJob: any;
  let FREE: any, PAID: any, ADMIN: any, OTHER: any;

  const startOfTodayMinus = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

  beforeAll(async () => {
    const host = new URL(PG_URL!).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error(`refusing to run destructive integration tests against non-loopback host ${host}`);
    }
    db = await import('../../src/lib/db');
    prisma = (db.db as any).prisma;
    retry = (await import('../../src/routes/api/video/[id]/retry/+server')).POST;
    reopen = (await import('../../src/routes/api/video/[id]/reopen/+server')).POST;
    webhook = (await import('../../src/routes/api/i2v-webhook/[id]/+server')).POST;
    kickoff = (await import('../../src/routes/api/i2v/kickoff/+server')).POST;
    submitJob = (await import('../../src/lib/local-queue')).submitJob;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE videos, video_likes, sessions, api_tokens, sponsor_claims, users, workflows RESTART IDENTITY CASCADE',
    );
    // updateAdminSettings upserts and invalidates the 30s settings cache in $lib/db.
    await db.updateAdminSettings({
      roles: [
        { name: 'free' },
        { name: 'paid', allowAdvancedFeatures: true },
        { name: 'admin', allowAdvancedFeatures: true },
      ],
      quotaPerDay: { free: 2, paid: 10, admin: 10 },
      freeUserQueueLimit: 3,
      paidUserQueueLimit: 5,
      maxQueueThreshold: 100,
      localQueueThreshold: 0,
    } as any);
    FREE = await db.createUser('free-u', 'x', 'free@example.test', ['free']);
    PAID = await db.createUser('paid-u', 'x', 'paid@example.test', ['paid']);
    ADMIN = await db.createUser('admin-u', 'x', 'admin@example.test', ['admin']);
    OTHER = await db.createUser('other-u', 'x', 'other@example.test', ['free']);
    await db.db.createWorkflow({
      id: 'w1', name: 'Wan', templatePath: 'wan.json', workflowType: 'i2v', isDefault: true,
      compatibleLoraIds: [], quotaCost: 1,
      capabilities: { steps: [4, 6], resolutions: ['480p', '720p', '720p-hd'], freeSteps: 4 },
    } as any);
    h.runpod.submit = vi.fn(async () => ({ id: 'rp-new' }));
    h.runpod.retry = vi.fn(async () => ({}));
    h.runpod.status = vi.fn(async () => ({ status: 'FAILED' }));
  });

  // ---- helpers ----
  const seed = (over: any = {}) =>
    db.createVideoEntry({
      user_id: FREE.id, original_image_url: 'https://x/a.png', prompt: 'p', status: 'failed',
      job_id: 'rp-old', is_local_job: false, workflow_id: 'w1', quota_cost: 1, iteration_steps: 4,
      video_resolution: '480p', processing_started_at: '2020-01-01T00:00:00.000Z',
      dequeued_at: '2020-01-01T00:00:00.000Z', tags: [], suggested_prompts: [],
      ...over,
    });
  const row = (id: string) => prisma.video.findUnique({ where: { id } });
  const quota = (userId: string) => db.db.getDailyQuotaUsage(userId, new Date());
  const callRetry = (user: any, id: string) =>
    retry({ params: { id }, request: new Request(`http://x/api/video/${id}/retry`, { method: 'POST' }), locals: { user } });
  const callReopen = (user: any, id: string) => reopen({ params: { id }, locals: { user } });
  const callWebhook = (id: string, body: any) =>
    webhook({ params: { id }, request: new Request(`http://x/api/i2v-webhook/${id}`, { method: 'POST', body: JSON.stringify(body) }) });
  const callKickoff = (user: any, body: any) =>
    kickoff({
      request: new Request('http://x/api/i2v/kickoff', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      locals: { user },
    });

  // ==================== (a) undefined vs null ====================
  describe('(a) updateVideo undefined / null', () => {
    it('undefined leaves processing_started_at (and dequeued_at) untouched; null clears them', async () => {
      const v = await seed({ status: 'failed' });
      const before = await row(v.id);
      expect(before.processingStartedAt).toBeInstanceOf(Date);

      // undefined is skipped: same value, and the other field in the patch is still applied
      await db.updateVideo(v.id, { status: 'in_queue', processing_started_at: undefined, dequeued_at: undefined } as any);
      const afterUndef = await row(v.id);
      expect(afterUndef.status).toBe('in_queue');
      expect(afterUndef.processingStartedAt?.toISOString()).toBe(before.processingStartedAt.toISOString());
      expect(afterUndef.dequeuedAt?.toISOString()).toBe(before.dequeuedAt.toISOString());

      // null really clears
      await db.updateVideo(v.id, { processing_started_at: null, dequeued_at: null } as any);
      const afterNull = await row(v.id);
      expect(afterNull.processingStartedAt).toBeNull();
      expect(afterNull.dequeuedAt).toBeNull();
    });
  });

  // ==================== (b) getDailyQuotaUsage ====================
  describe('(b) getDailyQuotaUsage', () => {
    it('counts only today + processing_started_at set + completed/in_queue/processing', async () => {
      const now = new Date().toISOString();
      const y = startOfTodayMinus(26); // always yesterday or earlier, even right after midnight
      await seed({ id: 'c1', status: 'completed', quota_cost: 2, processing_started_at: now });
      await seed({ id: 'q1', status: 'in_queue', quota_cost: 3, processing_started_at: now });
      await seed({ id: 'p1', status: 'processing', quota_cost: 4, processing_started_at: now });
      // not counted:
      await seed({ id: 'f1', status: 'failed', quota_cost: 100, processing_started_at: now });
      await seed({ id: 'n1', status: 'in_queue', quota_cost: 100, processing_started_at: null });
      await seed({ id: 'yc', status: 'completed', quota_cost: 100, processing_started_at: y });
      await seed({ id: 'u1', status: 'uploaded', quota_cost: 100, processing_started_at: now });
      await seed({ id: 'o1', user_id: OTHER.id, status: 'completed', quota_cost: 100, processing_started_at: now });
      expect(await quota(FREE.id)).toBe(2 + 3 + 4);
      expect(await quota(OTHER.id)).toBe(100);
    });
  });

  // ==================== (c) routes on the real DB ====================
  describe('(c) retry / reopen / webhook on real DB', () => {
    it('retry: quota full → 429, row byte-identical, nothing submitted', async () => {
      await seed({ id: 'a', status: 'completed', quota_cost: 2, processing_started_at: new Date().toISOString() });
      const v = await seed({ is_local_job: true, job_id: 'local-x-y' });
      const before = await row(v.id);
      const res = await callRetry(FREE, v.id);
      expect(res.status).toBe(429);
      expect((await res.json()).errorCode).toBe('quota_exceeded');
      expect(await row(v.id)).toEqual(before); // includes updatedAt: no write happened at all
      expect(h.runpod.submit).not.toHaveBeenCalled();
      expect(h.runpod.retry).not.toHaveBeenCalled();
    });

    it('retry: stored 720p-hd and owner without advanced features → 403, row unchanged', async () => {
      const v = await seed({ is_local_job: true, video_resolution: '720p-hd' });
      const before = await row(v.id);
      const res = await callRetry(FREE, v.id);
      expect(res.status).toBe(403);
      expect(await row(v.id)).toEqual(before);
      expect(h.runpod.submit).not.toHaveBeenCalled();
    });

    it.each([
      ['local job → RunPod', { is_local_job: true, job_id: 'local-x-y' }, (): void => undefined],
      ['404 resubmit', {}, (): void => { h.runpod.status = vi.fn(async () => { throw new Error('RunPod status 404'); }); }],
      ['original-job retry', {}, (): void => undefined],
    ] as [string, any, () => void][])('retry success (%s): processing_started_at set, in_queue, quota usage increases', async (_n, over, setup) => {
      const v = await seed(over);
      setup();
      expect(await quota(FREE.id)).toBe(0);
      const before = Date.now();
      const res = await callRetry(FREE, v.id);
      expect(res.status).toBe(200);
      const after = await row(v.id);
      expect(after.status).toBe('in_queue');
      expect(after.processingStartedAt).toBeInstanceOf(Date);
      expect(after.processingStartedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(after.dequeuedAt).toBeNull();
      expect(await quota(FREE.id)).toBe(1);
      if (over.is_local_job) {
        expect(after.isLocalJob).toBe(false);
        expect(after.jobId).toBe('rp-new');
      }
    });

    it('retry: a non-owner and an admin both get 404 for someone else\'s video; row unchanged', async () => {
      const v = await seed({ is_local_job: true });
      const before = await row(v.id);
      for (const caller of [OTHER, ADMIN]) {
        const res = await callRetry(caller, v.id);
        expect(res.status).toBe(404);
      }
      expect(await row(v.id)).toEqual(before);
      expect(h.runpod.submit).not.toHaveBeenCalled();
    });

    it('reopen: clears job_id / is_local_job / timing fields in the DB, then retry refuses', async () => {
      const v = await seed({ is_local_job: true, job_id: 'local-x-y', progress_percentage: 50 });
      const res = await callReopen(FREE, v.id);
      expect(res.status).toBe(200);
      const after = await row(v.id);
      expect(after).toMatchObject({ status: 'uploaded', jobId: null, isLocalJob: false, processingStartedAt: null, dequeuedAt: null, progressPercentage: null });
      expect((await callRetry(FREE, v.id)).status).toBe(400);
    });

    it('webhook: completed row → 200 ignored, row unchanged; stale job id after reopen → 403', async () => {
      const v = await seed({ status: 'completed', job_id: 'rp-1', final_video_url: 'https://s3.test/done.mp4' });
      const before = await row(v.id);
      const res = await callWebhook(v.id, { id: 'rp-1', status: 'FAILED' });
      expect(res.status).toBe(200);
      expect((await res.json()).ignored).toMatch(/completed/);
      expect(await row(v.id)).toEqual(before);

      const v2 = await seed({ id: 'v2', status: 'failed', job_id: 'rp-2' });
      await callReopen(FREE, v2.id);
      const stale = await callWebhook(v2.id, { id: 'rp-2', status: 'COMPLETED' });
      expect(stale.status).toBe(403);
      expect((await row(v2.id)).status).toBe('uploaded');
    });

    it('webhook: in_queue row is updated normally', async () => {
      const v = await seed({ status: 'in_queue', job_id: 'rp-3', dequeued_at: null, processing_started_at: new Date(Date.now() - 600_000).toISOString() });
      const res = await callWebhook(v.id, { id: 'rp-3', status: 'PROCESSING', progress: { percentage: 42, completed_nodes: 1, total_nodes: 4 } });
      expect(res.status).toBe(201);
      const after = await row(v.id);
      expect(after.status).toBe('processing');
      expect(after.progressPercentage).toBe(42);
      expect(after.dequeuedAt).toBeInstanceOf(Date);
      // completion with a video file
      const done = await callWebhook(v.id, { id: 'rp-3', status: 'COMPLETED', files: [{ type: 's3_url', filename: 'o.mp4', data: 'https://s3.test/o.mp4' }] });
      expect(done.status).toBe(201);
      const fin = await row(v.id);
      expect(fin.status).toBe('completed');
      expect(fin.finalVideoUrl).toBe('https://s3.test/o.mp4');
      expect(fin.progressPercentage).toBeNull();
      expect(fin.processingTimeMs).toBeGreaterThanOrEqual(600_000); // Int column: only fits ~24.8 days of elapsed ms
    });
  });

  // ==================== (d) local job id ====================
  describe('(d) local job id fits job_id VarChar(200)', () => {
    it('real submitJob writes local-<cuid>-<uuid> and reads it back', async () => {
      const v = await seed({ status: 'in_queue', job_id: undefined, is_local_job: false });
      const settings = await db.getAdminSettings();
      const res = await submitJob(
        null, v, FREE, { ...settings, localQueueThreshold: 5 },
        db.getLocalJobStats, db.claimJobForMigration, db.updateVideo, 'auto', async () => ({}),
      );
      expect(res.isLocal).toBe(true);
      expect(res.jobId).toMatch(new RegExp(`^local-${v.id}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
      expect(res.jobId.length).toBeLessThanOrEqual(200);
      const stored = await row(v.id);
      expect(stored.jobId).toBe(res.jobId);
      expect(stored.isLocalJob).toBe(true);
      expect((await db.getVideoById(v.id)).job_id).toBe(res.jobId);
    });
  });

  // ==================== (e) kickoff ====================
  describe('(e) kickoff', () => {
    const uploaded = (over: any = {}) =>
      seed({
        status: 'uploaded', job_id: undefined, workflow_id: undefined, quota_cost: 1, iteration_steps: 4,
        video_resolution: '480p', processing_started_at: undefined, dequeued_at: undefined,
        is_nsfw: true, validation_metadata: { manual_recognition_done: true }, // no detached revalidation
        ...over,
      });
    const gated = ['workflowId', 'quotaCost', 'iterationSteps', 'videoDuration', 'videoResolution', 'additionalOptions', 'loraWeights', 'seed', 'status', 'processingStartedAt'];

    it('403 premium resolution: gated columns untouched, prompt saved', async () => {
      const v = await uploaded();
      const before = await row(v.id);
      const res = await callKickoff(FREE, { id: v.id, prompt: 'new prompt', videoResolution: '720p-hd' });
      expect(res.status).toBe(403);
      const after = await row(v.id);
      expect(after.prompt).toBe('new prompt');
      for (const k of gated) expect(after[k]).toEqual(before[k]);
      expect(after).toMatchObject({ videoResolution: '480p', iterationSteps: 4, quotaCost: 1, workflowId: null });
    });

    it('403 premium steps and 429 over quota: gated columns untouched', async () => {
      const v = await uploaded();
      const before = await row(v.id);
      const r1 = await callKickoff(FREE, { id: v.id, iterationSteps: 6 });
      expect(r1.status).toBe(403);
      await db.updateAdminSettings({ quotaPerDay: { free: 0, paid: 10, admin: 10 } } as any);
      const r2 = await callKickoff(FREE, { id: v.id, prompt: 'q' });
      expect(r2.status).toBe(429);
      const after = await row(v.id);
      for (const k of gated) expect(after[k]).toEqual(before[k]);
    });

    it('success (RunPod path): gated fields + in_queue + processing_started_at persisted, quota charged', async () => {
      const v = await uploaded({ user_id: PAID.id });
      const res = await callKickoff(PAID, { id: v.id, prompt: 'go', videoResolution: '720p-hd', iterationSteps: 6 });
      expect(res.status).toBe(200);
      const after = await row(v.id);
      expect(after).toMatchObject({ prompt: 'go', workflowId: 'w1', videoResolution: '720p-hd', iterationSteps: 6, status: 'in_queue', jobId: 'rp-new', isLocalJob: false });
      expect(after.processingStartedAt).toBeInstanceOf(Date);
      expect(await quota(PAID.id)).toBe(1);
    });

    it('success (local queue path): stores local-<cuid>-<uuid> job id', async () => {
      await db.updateAdminSettings({ localQueueThreshold: 5 } as any);
      const v = await uploaded();
      const res = await callKickoff(FREE, { id: v.id, prompt: 'go' });
      expect(res.status).toBe(200);
      const after = await row(v.id);
      expect(after.isLocalJob).toBe(true);
      expect(after.jobId).toMatch(new RegExp(`^local-${v.id}-[0-9a-f-]{36}$`));
      expect(h.runpod.submit).not.toHaveBeenCalled();
    });
  });
});
