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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { __setUserLockTimeoutForTest, __userLockSize } from '../../src/lib/userLock';

const PG_URL = process.env.PG_TEST_URL;

const h = vi.hoisted(() => ({
  runpod: { submit: null as any, retry: null as any, status: null as any } as Record<'submit' | 'retry' | 'status', any>,
  oauthUserInfo: {} as any,
}));

vi.mock('$env/dynamic/private', () => ({
  env: { DATABASE_PROVIDER: 'postgres', DATABASE_URL: process.env.PG_TEST_URL, S3_ALLOWED_URL_PREFIXES: 'https://s3.test/' },
}));
vi.mock('$lib/runpod', () => ({
  getRunPodConfig: () => ({ url: 'http://runpod.test', key: 'k' }),
  getRunPodHealth: async () => ({ jobs: { inQueue: 0 } }),
  getRunPodJobStatus: (...a: any[]) => h.runpod.status(...a),
  mapRunPodStatus: (s: string) =>
    ({ FAILED: 'failed', COMPLETED: 'completed', IN_QUEUE: 'in_queue', IN_PROGRESS: 'processing' } as any)[s] ?? 'failed',
  retryRunPodJob: (...a: any[]) => h.runpod.retry(...a),
  PROCESSING_TIMEOUT_MS: 30 * 60 * 1000,
  submitRunPodJob: (...a: any[]) => h.runpod.submit(...a),
}));
vi.mock('$lib/jobWorkflow', () => ({
  buildJobWorkflow: async () => ({ payload: { input: {} } }),
  getCallbackUrl: (origin: string, id: string) => `${origin}/api/i2v-webhook/${id}`,
}));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => 'https://s3.test/x.mp4' }));
vi.mock('$lib/serverImageUrl', () => ({ toOriginalUrl: (u: string) => u, toProxiedUrl: (u: string) => u }));
vi.mock('$lib/ref2vPoster', () => ({ extractRef2VPosterFromResult: async () => null }));
vi.mock('$lib/oauth', () => ({
  exchangeCodeForTokens: async () => ({ access_token: 'at-test', token_type: 'Bearer', expires_in: 3600 }),
  getUserInfo: async () => h.oauthUserInfo,
}));
vi.mock('$lib/imageRecognition', () => ({ evaluatePromptProperties: async () => ({}) }));

describe.skipIf(!PG_URL)('real Postgres integration', () => {
  let db: any; // real $lib/db module (delegates to a real PostgresDatabase)
  let prisma: any;
  let retry: any, reopen: any, webhook: any, kickoff: any, submitJob: any, runQueueSweep: any, oauthCallback: any;
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
    runQueueSweep = (await import('../../src/lib/queueSweeper')).runQueueSweep;
    oauthCallback = (await import('../../src/routes/auth/gmgard/callback/+page.server')).load;
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

  // ==================== OAuth identity binding (A6) ====================
  describe('OAuth identity binding', () => {
    const userRow = (username: string) => prisma.user.findUnique({ where: { username } });
    const callback = async (userInfo: any) => {
      h.oauthUserInfo = userInfo;
      const store: Record<string, string> = { oauth_state: 'st', oauth_verifier: 'ver' };
      const cookies = { get: (k: string) => store[k], set: vi.fn(), delete: vi.fn() };
      try {
        await oauthCallback({ url: new URL('http://x/auth/gmgard/callback?code=c&state=st'), cookies });
        return { thrown: null, cookies };
      } catch (e) {
        return { thrown: e, cookies };
      }
    };
    const loggedInAs = async (r: any) => {
      expect(isRedirect(r.thrown) && r.thrown.status === 302).toBe(true);
      const token = r.cookies.set.mock.calls.find((c: any[]) => c[0] === 'session')?.[1];
      expect(token).toBeTruthy();
      const sess = await prisma.session.findUnique({ where: { token }, include: { user: true } });
      return sess?.user;
    };
    const status = (r: any) => (isHttpError(r.thrown) ? r.thrown.status : null);

    it('the new migration is applied: columns are nullable, unique index exists', async () => {
      const cols = await prisma.$queryRawUnsafe(
        "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='users' AND column_name IN ('oauth_provider','oauth_sub') ORDER BY column_name");
      expect(cols).toEqual([
        { column_name: 'oauth_provider', is_nullable: 'YES', column_default: null },
        { column_name: 'oauth_sub', is_nullable: 'YES', column_default: null },
      ]);
      const idx = await prisma.$queryRawUnsafe("SELECT indexdef FROM pg_indexes WHERE indexname='users_oauth_provider_oauth_sub_key'");
      expect(idx[0].indexdef).toMatch(/UNIQUE.*\(oauth_provider, oauth_sub\)/);
    });

    it('unique index: the same (provider, sub) cannot belong to two users; NULLs never collide', async () => {
      // the seeded users all have NULL/NULL and coexist
      expect(await prisma.user.count({ where: { oauthSub: null } })).toBe(4);
      const a = await db.createOAuthUser({ username: 'ga', password_hash: 'h', provider: 'gmgard', sub: 'S1', roles: ['gmgard-user'] });
      expect(a).toMatchObject({ username: 'ga', oauth_provider: 'gmgard', oauth_sub: 'S1' });
      expect(await db.createOAuthUser({ username: 'gb', password_hash: 'h', provider: 'gmgard', sub: 'S1' })).toBeNull();
      expect(await userRow('gb')).toBeNull();
      // same sub under another provider is a different identity
      expect(await db.createOAuthUser({ username: 'gc', password_hash: 'h', provider: 'other', sub: 'S1' })).not.toBeNull();
      // raw insert hits the real index
      await expect(prisma.user.create({ data: { username: 'gd', passwordHash: 'h', oauthProvider: 'gmgard', oauthSub: 'S1' } }))
        .rejects.toMatchObject({ code: 'P2002' });
      // duplicate username -> null, not a throw
      expect(await db.createOAuthUser({ username: 'ga', password_hash: 'h', provider: 'gmgard', sub: 'S2' })).toBeNull();
    });

    it('getUserByOAuthIdentity finds the bound user only for the exact (provider, sub)', async () => {
      const a = await db.createOAuthUser({ username: 'ga', password_hash: 'h', provider: 'gmgard', sub: 'S1' });
      expect((await db.getUserByOAuthIdentity('gmgard', 'S1'))?.id).toBe(a.id);
      expect(await db.getUserByOAuthIdentity('gmgard', 'S2')).toBeUndefined();
      expect(await db.getUserByOAuthIdentity('other', 'S1')).toBeUndefined();
    });

    it('linkOAuthIdentity only writes while oauth_sub IS NULL; concurrent binds of different subs: exactly one wins', async () => {
      const legacy = await db.createUser('legacy', 'x', undefined, ['gmgard-user']);
      const results = await Promise.all([
        db.linkOAuthIdentity(legacy.id, 'gmgard', 'SUB-A'),
        db.linkOAuthIdentity(legacy.id, 'gmgard', 'SUB-B'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const row = await userRow('legacy');
      expect(row.oauthProvider).toBe('gmgard');
      expect(row.oauthSub).toBe(results[0] ? 'SUB-A' : 'SUB-B');

      // already bound -> refuses, value unchanged
      const winner = row.oauthSub;
      expect(await db.linkOAuthIdentity(legacy.id, 'gmgard', 'SUB-C')).toBe(false);
      expect((await userRow('legacy')).oauthSub).toBe(winner);
      // (provider, sub) held by someone else -> false (unique violation swallowed), user stays unbound
      const other = await db.createUser('legacy2', 'x', undefined, ['gmgard-user']);
      expect(await db.linkOAuthIdentity(other.id, 'gmgard', winner)).toBe(false);
      expect((await userRow('legacy2')).oauthSub).toBeNull();
      // unknown user
      expect(await db.linkOAuthIdentity('nope', 'gmgard', 'SUB-Z')).toBe(false);
    });

    it('legacy OAuth account (gmgard-user, no sub): first login binds, second login goes by sub even after a rename', async () => {
      const legacy = await db.createUser('alice', 'legacy-non-bcrypt', 'alice@example.test', ['gmgard-user']);
      let r = await callback({ sub: 'GM-1', preferred_username: 'alice', email: 'alice@example.test' });
      expect((await loggedInAs(r))?.id).toBe(legacy.id);
      expect(await userRow('alice')).toMatchObject({ oauthProvider: 'gmgard', oauthSub: 'GM-1' });

      r = await callback({ sub: 'GM-1', preferred_username: 'alice-renamed' });
      expect((await loggedInAs(r))?.id).toBe(legacy.id);
      expect(await userRow('alice-renamed')).toBeNull();
      expect(await prisma.user.count({ where: { oauthSub: 'GM-1' } })).toBe(1);
    });

    it('hijack by squatting: a locally registered account with the victim\'s GmGard name is NOT logged into, row unchanged', async () => {
      const mine = await db.createUser('victim', await bcrypt.hash('attacker-pw', 4), 'a@example.test', []);
      const before = await userRow('victim');
      const r = await callback({ sub: 'GM-VICTIM', preferred_username: 'victim', email: 'v@example.test' });
      expect(status(r)).toBe(403);
      expect(r.cookies.set).not.toHaveBeenCalled();
      expect(await prisma.session.count()).toBe(0);
      expect(await userRow('victim')).toEqual(before);
      expect(mine.id).toBe(before.id);
      expect(await prisma.user.count({ where: { oauthSub: 'GM-VICTIM' } })).toBe(0);
    });

    it('impersonation: a local privileged account (roles [admin], no gmgard-user) is not reachable through a same-named GmGard account', async () => {
      await db.createUser('root', await bcrypt.hash('pw', 4), undefined, ['admin']);
      const r = await callback({ sub: 'GM-EVIL', preferred_username: 'root' });
      expect(status(r)).toBe(403);
      expect(await prisma.session.count()).toBe(0);
      expect((await userRow('root')).oauthSub).toBeNull();
    });

    it('an account already bound to another sub rejects a different GmGard identity with the same name', async () => {
      await db.createOAuthUser({ username: 'bob', password_hash: 'h', provider: 'gmgard', sub: 'GM-BOB', roles: ['gmgard-user'] });
      const r = await callback({ sub: 'GM-IMPOSTOR', preferred_username: 'bob' });
      expect(status(r)).toBe(403);
      expect(await prisma.session.count()).toBe(0);
      expect((await userRow('bob')).oauthSub).toBe('GM-BOB');
      expect(await prisma.user.count({ where: { oauthSub: 'GM-IMPOSTOR' } })).toBe(0);
    });

    it('new user: created with gmgard-user + identity; password_hash is a valid bcrypt nobody can match; later login by sub', async () => {
      let r = await callback({ sub: 'GM-NEW', preferred_username: 'newbie', email: 'new@example.test' });
      const u = await loggedInAs(r);
      expect(u).toMatchObject({ username: 'newbie', email: 'new@example.test', oauthProvider: 'gmgard', oauthSub: 'GM-NEW' });
      expect(JSON.parse(u.roles)).toEqual(['gmgard-user']);
      expect(u.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/);
      for (const guess of ['password', '123456', 'newbie', 'admin', '', 'qwerty', '0.5', 'undefined']) {
        expect(await bcrypt.compare(guess, u.passwordHash)).toBe(false);
      }
      // password login path (authenticateUser) also fails
      const { authenticateUser } = await import('../../src/lib/auth');
      expect(await authenticateUser('newbie', 'password')).toBeNull();

      r = await callback({ sub: 'GM-NEW', preferred_username: 'newbie-2' });
      expect((await loggedInAs(r))?.id).toBe(u.id);
      expect(await prisma.user.count({ where: { oauthSub: 'GM-NEW' } })).toBe(1);
    });

    it('new user whose email is already held by a local account is still created (without the email)', async () => {
      await db.createUser('local-mail', 'x', 'taken@example.test', []);
      const r = await callback({ sub: 'GM-M', preferred_username: 'mailer', email: 'taken@example.test' });
      const u = await loggedInAs(r);
      expect(u).toMatchObject({ username: 'mailer', email: null, oauthSub: 'GM-M' });
    });

    it('concurrent first logins of the same new identity yield one user and two successful logins', async () => {
      const info = { sub: 'GM-RACE', preferred_username: 'racer', email: 'race@example.test' };
      const [r1, r2] = await Promise.all([callback(info), callback(info)]);
      expect(await prisma.user.count({ where: { oauthSub: 'GM-RACE' } })).toBe(1);
      const u1 = await loggedInAs(r1);
      const u2 = await loggedInAs(r2);
      expect(u1.id).toBe(u2.id);
    });

    it('concurrent first logins of a legacy account from the same identity both succeed (bind once)', async () => {
      const legacy = await db.createUser('oldtimer', 'x', undefined, ['gmgard-user']);
      const info = { sub: 'GM-OLD', preferred_username: 'oldtimer' };
      const [r1, r2] = await Promise.all([callback(info), callback(info)]);
      expect((await loggedInAs(r1))?.id).toBe(legacy.id);
      expect((await loggedInAs(r2))?.id).toBe(legacy.id);
      expect((await userRow('oldtimer')).oauthSub).toBe('GM-OLD');
    });

    it('public user mappings do not expose oauth_sub / password_hash', async () => {
      const u = await db.createOAuthUser({ username: 'pub', password_hash: 'hash-secret', provider: 'gmgard', sub: 'GM-PUB', roles: ['gmgard-user'] });
      const { authenticateUser, getUserByIdPublic } = await import('../../src/lib/auth');
      const pub = await getUserByIdPublic(u.id);
      expect(Object.keys(pub as any).sort()).toEqual(['created_at', 'email', 'id', 'roles', 'updated_at', 'username']);
      const all = await db.getAllUsers();
      for (const x of all) {
        expect(x).not.toHaveProperty('oauth_sub');
        expect(x).not.toHaveProperty('oauth_provider');
        expect(x).not.toHaveProperty('password_hash');
      }
      void authenticateUser;
    });
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
  // ==================== (f) per-user submission lock (A4) ====================
  // kickoff / retry are check-then-write flows (status -> daily credits -> queue
  // limit -> flip to in_queue -> submit). Without a lock, concurrent requests of
  // the same user all read the old state. Set A4_REPORT=1 to print the raw
  // numbers (success counts / submit calls) of each scenario.
  describe('(f) per-user lock on kickoff / retry (A4)', () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const report = (label: string, data: Record<string, unknown>) => {
      if (process.env.A4_REPORT) console.info(`[A4] ${label}: ${JSON.stringify(data)}`);
    };
    const SUBMIT_DELAY_MS = 40; // stands in for the RunPod network round trip: widens the race window

    const draft = (over: any = {}) =>
      seed({
        status: 'uploaded', job_id: undefined, workflow_id: undefined, quota_cost: 1, iteration_steps: 4,
        video_resolution: '480p', processing_started_at: undefined, dequeued_at: undefined,
        is_nsfw: true, validation_metadata: { manual_recognition_done: true }, // no detached revalidation
        ...over,
      });
    const drafts = (n: number, over: any = {}) => Promise.all(Array.from({ length: n }, () => draft(over)));
    const failedRow = (over: any = {}) => seed({ status: 'failed', job_id: 'rp-old', ...over });
    const activeCount = (userId: string) =>
      prisma.video.count({ where: { userId, status: { in: ['in_queue', 'processing'] } } });
    const statuses = (rs: Response[]) => rs.map((r) => r.status);
    const count = (xs: number[], s: number) => xs.filter((x) => x === s).length;

    let n = 0;
    const slowSubmit = () => {
      n = 0;
      h.runpod.submit = vi.fn(async () => {
        await sleep(SUBMIT_DELAY_MS);
        return { id: `rp-new-${++n}` };
      });
    };
    const waitUntil = async (cond: () => boolean, ms = 3000) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('waitUntil timed out');
        await sleep(5);
      }
    };

    beforeEach(() => {
      __setUserLockTimeoutForTest(null);
      slowSubmit();
    });
    afterEach(() => __setUserLockTimeoutForTest(null));

    it('same video, 10 concurrent kickoffs: exactly one submission, the other 9 get 400 already processing', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 100, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      const v = await draft();
      const res = await Promise.all(Array.from({ length: 10 }, () => callKickoff(FREE, { id: v.id, prompt: 'go' })));
      const st = statuses(res);
      report('same video x10', { ok: count(st, 200), already_processing_400: count(st, 400), submitCalls: h.runpod.submit.mock.calls.length });
      expect(count(st, 200)).toBe(1);
      expect(count(st, 400)).toBe(9);
      for (const r of res.filter((r) => r.status === 400)) expect((await r.json()).error).toBe('already processing');
      expect(h.runpod.submit).toHaveBeenCalledTimes(1);
      const after = await row(v.id);
      expect(after).toMatchObject({ status: 'in_queue', jobId: 'rp-new-1' });
    });

    it('daily credits = 3, 10 drafts of one user at once: exactly 3 pass, 7 get 429 quota_exceeded', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 3, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      const vs = await drafts(10);
      const res = await Promise.all(vs.map((v: any) => callKickoff(FREE, { id: v.id })));
      const st = statuses(res);
      const queued = await activeCount(FREE.id);
      report('quota 3, 10 drafts', { ok: count(st, 200), s429: count(st, 429), submitCalls: h.runpod.submit.mock.calls.length, queuedInDb: queued, creditsUsed: await quota(FREE.id) });
      expect(count(st, 200)).toBe(3);
      expect(count(st, 429)).toBe(7);
      for (const r of res.filter((r) => r.status === 429)) expect((await r.json()).errorCode).toBe('quota_exceeded');
      expect(queued).toBe(3);
      expect(h.runpod.submit).toHaveBeenCalledTimes(3);
      expect(await quota(FREE.id)).toBe(3);
    });

    it('queue limit = 2, 10 drafts at once: exactly 2 pass, 8 get 429 queue_limit', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 100, paid: 10, admin: 10 }, freeUserQueueLimit: 2 } as any);
      const vs = await drafts(10);
      const res = await Promise.all(vs.map((v: any) => callKickoff(FREE, { id: v.id })));
      const st = statuses(res);
      const queued = await activeCount(FREE.id);
      report('queue limit 2, 10 drafts', { ok: count(st, 200), s429: count(st, 429), submitCalls: h.runpod.submit.mock.calls.length, queuedInDb: queued });
      expect(count(st, 200)).toBe(2);
      expect(count(st, 429)).toBe(8);
      for (const r of res.filter((r) => r.status === 429)) expect((await r.json()).errorCode).toBe('queue_limit');
      expect(queued).toBe(2);
      expect(h.runpod.submit).toHaveBeenCalledTimes(2);
    });

    it('rejected requests under contention leave the draft untouched (gated columns not persisted)', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 1, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      const vs = await drafts(4);
      const before = await Promise.all(vs.map((v: any) => row(v.id)));
      const res = await Promise.all(vs.map((v: any) => callKickoff(FREE, { id: v.id, iterationSteps: 4 })));
      const rejectedIdx = res.map((r, i) => (r.status === 429 ? i : -1)).filter((i) => i >= 0);
      expect(rejectedIdx).toHaveLength(3);
      for (const i of rejectedIdx) {
        const after = await row(vs[i].id);
        expect(after.status).toBe('uploaded');
        expect(after.workflowId).toBeNull();
        expect(after.processingStartedAt).toBeNull();
        expect(after.jobId).toBeNull();
        expect(before[i].status).toBe('uploaded');
      }
    });

    it('kickoff + retry of one user at once with 1 credit left: only one of them passes', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 1, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      h.runpod.retry = vi.fn(async () => { await sleep(SUBMIT_DELAY_MS); return {}; });
      const d = await draft();
      const f = await failedRow(); // processing_started_at in 2020: does not count today
      expect(await quota(FREE.id)).toBe(0);
      const [rk, rr] = await Promise.all([callKickoff(FREE, { id: d.id }), callRetry(FREE, f.id)]);
      const st = [rk.status, rr.status];
      report('kickoff+retry, 1 credit', { kickoff: rk.status, retry: rr.status, submitCalls: h.runpod.submit.mock.calls.length, retryCalls: h.runpod.retry.mock.calls.length, creditsUsed: await quota(FREE.id) });
      expect(count(st, 200)).toBe(1);
      expect(count(st, 429)).toBe(1);
      expect(h.runpod.submit.mock.calls.length + h.runpod.retry.mock.calls.length).toBe(1);
      expect(await quota(FREE.id)).toBe(1);
      expect(await activeCount(FREE.id)).toBe(1);
    });

    it('3 kickoffs + 3 retries mixed (3 failed rows), 1 credit left: exactly one passes overall', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 1, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      h.runpod.retry = vi.fn(async () => { await sleep(SUBMIT_DELAY_MS); return {}; });
      const ds = await drafts(3);
      const fs = await Promise.all(Array.from({ length: 3 }, () => failedRow()));
      const calls = [
        ...ds.map((d: any) => callKickoff(FREE, { id: d.id })),
        ...fs.map((f: any) => callRetry(FREE, f.id)),
      ];
      const st = statuses(await Promise.all(calls));
      report('3 kickoff + 3 retry, 1 credit', { ok: count(st, 200), s429: count(st, 429), submitCalls: h.runpod.submit.mock.calls.length, retryCalls: h.runpod.retry.mock.calls.length, creditsUsed: await quota(FREE.id) });
      expect(count(st, 200)).toBe(1);
      expect(count(st, 429)).toBe(5);
      expect(await quota(FREE.id)).toBe(1);
    });

    it('queue limit also holds between kickoff and retry (limit 1, one active slot): one passes', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 100, paid: 10, admin: 10 }, freeUserQueueLimit: 1 } as any);
      h.runpod.retry = vi.fn(async () => { await sleep(SUBMIT_DELAY_MS); return {}; });
      const d = await draft();
      const f = await failedRow();
      const [rk, rr] = await Promise.all([callKickoff(FREE, { id: d.id }), callRetry(FREE, f.id)]);
      expect(count([rk.status, rr.status], 200)).toBe(1);
      expect(count([rk.status, rr.status], 429)).toBe(1);
      expect(await activeCount(FREE.id)).toBe(1);
    });

    it('a user whose lock is busy does not block another user', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 100, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      h.runpod.submit = vi.fn(async () => {
        calls++;
        if (calls === 1) await gate; // the first submission (user A) hangs
        return { id: `rp-${calls}` };
      });
      const a1 = await draft({ user_id: FREE.id });
      const a2 = await draft({ user_id: FREE.id });
      const b1 = await draft({ user_id: OTHER.id });
      const order: string[] = [];
      const pA1 = callKickoff(FREE, { id: a1.id }).then((r: Response) => { order.push('A1'); return r; });
      await waitUntil(() => calls === 1);
      const pA2 = callKickoff(FREE, { id: a2.id }).then((r: Response) => { order.push('A2'); return r; }); // queued behind A1
      const rB = await callKickoff(OTHER, { id: b1.id });
      order.push('B1');
      expect(rB.status).toBe(200);
      expect(order).toEqual(['B1']); // A1 still stuck, A2 still waiting for A1
      expect(calls).toBe(2); // only A1 and B1 reached submit
      release();
      const [rA1, rA2] = await Promise.all([pA1, pA2]);
      expect([rA1.status, rA2.status]).toEqual([200, 200]);
      expect(order).toEqual(['B1', 'A1', 'A2']); // A2 only ran after A1 released
    });

    it('lock wait timeout: 429 busy (not 500) for kickoff and retry, nothing written for the busy requests', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 100, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      __setUserLockTimeoutForTest(60);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      h.runpod.submit = vi.fn(async () => { await gate; return { id: 'rp-slow' }; });
      const slow = await draft();
      const waiting = await draft({ prompt: 'untouched' });
      const f = await failedRow();

      const pSlow = callKickoff(FREE, { id: slow.id });
      await waitUntil(() => h.runpod.submit.mock.calls.length === 1);

      const t0 = Date.now();
      const rk = await callKickoff(FREE, { id: waiting.id, prompt: 'should not be saved' });
      const rr = await callRetry(FREE, f.id);
      const waited = Date.now() - t0;
      expect(rk.status).toBe(429);
      expect(await rk.json()).toMatchObject({ errorCode: 'busy', error: expect.stringContaining('请稍后重试') });
      expect(rr.status).toBe(429);
      expect((await rr.json()).errorCode).toBe('busy');
      expect(waited).toBeGreaterThanOrEqual(50); // really waited for the (shortened) timeout
      // the timed-out requests did not touch their rows
      expect(await row(waiting.id)).toMatchObject({ status: 'uploaded', prompt: 'untouched', jobId: null });
      expect(await row(f.id)).toMatchObject({ status: 'failed', jobId: 'rp-old' });
      expect(h.runpod.retry).not.toHaveBeenCalled();

      release();
      expect((await pSlow).status).toBe(200);
      // the lock is healthy afterwards
      const next = await callKickoff(FREE, { id: waiting.id });
      expect(next.status).toBe(200);
    });

    it('an error inside the critical section (submit throws) resets the video to failed and releases the lock', async () => {
      await db.updateAdminSettings({ quotaPerDay: { free: 100, paid: 10, admin: 10 }, freeUserQueueLimit: 100 } as any);
      let calls = 0;
      h.runpod.submit = vi.fn(async () => {
        await sleep(10);
        if (++calls === 1) throw new Error('runpod down');
        return { id: 'rp-ok' };
      });
      const [v1, v2] = await drafts(2);
      const [r1, r2] = await Promise.all([callKickoff(FREE, { id: v1.id }), callKickoff(FREE, { id: v2.id })]);
      expect(r1.status).toBe(500);
      expect(r2.status).toBe(200);
      expect((await row(v1.id)).status).toBe('failed');
      expect((await row(v2.id)).status).toBe('in_queue');
    });

    it('early 4xx returns (404 / 403 / 400) release the lock too', async () => {
      const other = await draft({ user_id: OTHER.id });
      const v = await draft();
      expect((await callKickoff(FREE, { id: 'nope' })).status).toBe(404);
      expect((await callKickoff(FREE, { id: other.id })).status).toBe(403);
      expect((await callKickoff(FREE, {})).status).toBe(400);
      __setUserLockTimeoutForTest(100); // any leaked lock would now surface as 429 busy
      expect((await callKickoff(FREE, { id: v.id })).status).toBe(200);
      expect(__userLockSize()).toBe(0);
    });
  });

  // ==================== (h) hourly queue sweeper ====================
  describe('(h) queue sweeper: failTimedOutProcessing / claimStaleLocalJob / runQueueSweep', () => {
    // admin_settings is not truncated between tests: pin the threshold this block depends on.
    beforeEach(async () => {
      await db.updateAdminSettings({ freeUserWaitThresholdMinutes: 30 } as any);
    });
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const iso = (minutes: number) => ago(minutes).toISOString();
    const local = (over: any = {}) =>
      seed({ status: 'in_queue', is_local_job: true, job_id: 'local-x', dequeued_at: undefined, processing_started_at: iso(60), ...over });
    const realDeps = (over: any = {}) => ({
      now: () => Date.now(),
      getAdminSettings: () => db.getAdminSettings(),
      failTimedOutProcessing: (c: Date) => db.failTimedOutProcessing(c),
      claimStaleLocalJob: (o: Date, ex?: string[]) => db.claimStaleLocalJob(o, ex),
      updateVideo: (id: string, patch: any) => db.updateVideo(id, patch),
      getRunPodConfig: () => ({ endpointUrl: 'http://runpod.test', apiKey: 'k' }),
      resolveCallbackBase: () => 'https://cb.example.test',
      buildPayload: async (v: any) => ({ input: { id: v.id } }),
      submitRunPodJob: (c: any, p: any) => h.runpod.submit(c, p),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      ...over,
    });

    describe('failTimedOutProcessing', () => {
      it('only flips processing rows with an expired dequeued_at; everything else is untouched', async () => {
        const expired1 = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-e1', dequeued_at: iso(31) });
        const expired2 = await seed({ status: 'processing', processing_started_at: iso(200), is_local_job: true, job_id: 'local-e2', dequeued_at: iso(600) });
        const fresh = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-f', dequeued_at: iso(5) });
        const noDeq = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-n', dequeued_at: null });
        const queued = await seed({ status: 'in_queue', job_id: 'rp-q', dequeued_at: iso(600) });
        const done = await seed({ status: 'completed', job_id: 'rp-c', dequeued_at: iso(600) });
        const failed = await seed({ status: 'failed', job_id: 'rp-x', dequeued_at: iso(600) });
        const uploaded = await seed({ status: 'uploaded', job_id: null, dequeued_at: iso(600) });
        const untouched = [fresh, noDeq, queued, done, failed, uploaded];
        const snap = await Promise.all(untouched.map((v) => row(v.id)));

        const ids = await db.failTimedOutProcessing(ago(30));
        expect(ids.sort()).toEqual([expired1.id, expired2.id].sort());

        for (const [i, v] of untouched.entries()) expect(await row(v.id)).toEqual(snap[i]);
        const e1 = await row(expired1.id);
        expect(e1.status).toBe('failed');
        expect(e1.jobId).toBe('rp-e1'); // job_id kept so a genuine late completion is still accepted
        expect((await row(expired2.id)).jobId).toBe('local-e2');
        expect(e1.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

        // idempotent
        expect(await db.failTimedOutProcessing(ago(30))).toEqual([]);
      });

      it('does not overwrite a row that already became completed (condition lives in the UPDATE)', async () => {
        const v = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-1', dequeued_at: iso(120) });
        await db.updateVideo(v.id, { status: 'completed', final_video_url: 'https://s3.test/ok.mp4' });
        const before = await row(v.id);
        expect(await db.failTimedOutProcessing(ago(30))).toEqual([]);
        expect(await row(v.id)).toEqual(before);
      });

      it('racing a completed webhook: the row ends completed, never failed', async () => {
        const v = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-r', dequeued_at: iso(120) });
        await Promise.all([
          db.failTimedOutProcessing(ago(30)),
          callWebhook(v.id, { id: 'rp-r', status: 'COMPLETED', files: [{ type: 's3_url', filename: 'o.mp4', data: 'https://s3.test/o.mp4' }] }),
        ]);
        expect((await row(v.id)).status).toBe('completed');
      });

      it('a late genuine COMPLETED callback is still accepted for a swept (failed) row', async () => {
        const v = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-late', dequeued_at: iso(120) });
        await db.failTimedOutProcessing(ago(30));
        expect((await row(v.id)).status).toBe('failed');
        const res = await callWebhook(v.id, { id: 'rp-late', status: 'COMPLETED', files: [{ type: 's3_url', filename: 'o.mp4', data: 'https://s3.test/late.mp4' }] });
        expect(res.status).toBe(201);
        expect((await row(v.id)).status).toBe('completed');
      });
    });

    describe('claimStaleLocalJob', () => {
      it('claims only stale local in_queue rows, oldest first, reserving them as processing with a dequeued_at leash', async () => {
        const stale = await local({ processing_started_at: iso(45) });
        const staler = await local({ processing_started_at: iso(90) });
        const young = await local({ processing_started_at: iso(10) });
        const rp = await seed({ status: 'in_queue', is_local_job: false, job_id: 'rp-q', processing_started_at: iso(500), dequeued_at: undefined });
        const processing = await seed({ status: 'processing', is_local_job: true, job_id: 'local-p', processing_started_at: iso(500), dequeued_at: iso(1) });
        const completed = await seed({ status: 'completed', is_local_job: true, job_id: 'local-c', processing_started_at: iso(500) });
        const failed = await seed({ status: 'failed', is_local_job: true, job_id: 'local-f', processing_started_at: iso(500) });
        const keep = [young, rp, processing, completed, failed];
        const snap = await Promise.all(keep.map((v) => row(v.id)));

        const first = await db.claimStaleLocalJob(ago(30));
        expect(first.id).toBe(staler.id);
        const r1 = await row(staler.id);
        expect(r1).toMatchObject({ status: 'processing', isLocalJob: true, jobId: 'local-x' });
        expect(r1.dequeuedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
        expect((await db.claimStaleLocalJob(ago(30))).id).toBe(stale.id);
        expect(await db.claimStaleLocalJob(ago(30))).toBeNull();

        for (const [i, v] of keep.entries()) expect(await row(v.id)).toEqual(snap[i]);
      });

      it('falls back to created_at when processing_started_at is null; a young created_at is not claimed', async () => {
        const oldCreated = await local({ processing_started_at: null });
        await prisma.video.update({ where: { id: oldCreated.id }, data: { createdAt: ago(120) } });
        const youngCreated = await local({ processing_started_at: null });
        expect((await db.claimStaleLocalJob(ago(30))).id).toBe(oldCreated.id);
        expect(await db.claimStaleLocalJob(ago(30))).toBeNull();
        expect((await row(youngCreated.id)).status).toBe('in_queue');
      });

      it('treats every role alike (paid user waiting under the threshold is NOT claimed; over it, is)', async () => {
        const paidYoung = await local({ user_id: PAID.id, processing_started_at: iso(5) });
        expect(await db.claimStaleLocalJob(ago(30))).toBeNull();
        const paidOld = await local({ user_id: PAID.id, processing_started_at: iso(50) });
        expect((await db.claimStaleLocalJob(ago(30))).id).toBe(paidOld.id);
        expect((await row(paidYoung.id)).status).toBe('in_queue');
      });

      it('excludeIds skips rows (also with an empty list)', async () => {
        const a = await local({ processing_started_at: iso(90) });
        const b = await local({ processing_started_at: iso(80) });
        expect((await db.claimStaleLocalJob(ago(30), [a.id])).id).toBe(b.id);
        expect((await db.claimStaleLocalJob(ago(30), [])).id).toBe(a.id);
      });

      it('concurrent claims never hand out the same row', async () => {
        const one = await local();
        const two = await Promise.all([db.claimStaleLocalJob(ago(30)), db.claimStaleLocalJob(ago(30))]);
        expect(two.filter(Boolean)).toHaveLength(1);
        expect(two.find(Boolean).id).toBe(one.id);

        const many = await Promise.all(Array.from({ length: 6 }, () => local()));
        const claims = await Promise.all(Array.from({ length: 10 }, () => db.claimStaleLocalJob(ago(30))));
        const got = claims.filter(Boolean).map((c: any) => c.id);
        expect(got).toHaveLength(6);
        expect(new Set(got).size).toBe(6);
        expect(new Set(got)).toEqual(new Set(many.map((m: any) => m.id)));
      });

      it('races a local worker claim: exactly one side wins the row', async () => {
        const v = await local();
        const [mine, workers] = await Promise.all([db.claimStaleLocalJob(ago(30)), db.claimLocalJob()]);
        expect([mine, workers].filter(Boolean)).toHaveLength(1);
        expect(((mine ?? workers) as any).id).toBe(v.id);
      });
    });

    describe('runQueueSweep end to end', () => {
      it('3 timed-out + 2 stale queued migrated; the rest untouched; migrated rows are not killed by the next sweep', async () => {
        const t1 = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-t1', dequeued_at: iso(40) });
        const t2 = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-t2', dequeued_at: iso(90) });
        const t3 = await seed({ status: 'processing', processing_started_at: iso(200), is_local_job: true, job_id: 'local-t3', dequeued_at: iso(300) });
        const m1 = await local({ processing_started_at: iso(100) });
        const m2 = await local({ user_id: PAID.id, processing_started_at: iso(35) });
        const keepRows = [
          await local({ processing_started_at: iso(10) }),                                                    // young local queue
          await seed({ status: 'in_queue', is_local_job: false, job_id: 'rp-q', processing_started_at: iso(500), dequeued_at: undefined }), // RunPod queue
          await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-fresh', dequeued_at: iso(3) }),                       // processing, not expired
          await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-nodeq', dequeued_at: null }),                         // processing, no dequeued_at
          await seed({ status: 'completed', job_id: 'rp-done', dequeued_at: iso(900) }),
          await seed({ status: 'failed', job_id: 'rp-fail', dequeued_at: iso(900) }),
          await seed({ status: 'uploaded', job_id: null, dequeued_at: null, processing_started_at: null }),
        ];
        const snap = await Promise.all(keepRows.map((v: any) => row(v.id)));
        const m1Started = (await row(m1.id)).processingStartedAt.toISOString();
        let n = 0;
        h.runpod.submit = vi.fn(async () => ({ id: `rp-mig-${++n}` }));

        const s = await runQueueSweep(realDeps());
        expect(s).toMatchObject({ timedOut: 3, migrated: 2, migrationFailed: 0 });
        expect(s.skipped).toBeUndefined();
        expect(s.timedOutIds.sort()).toEqual([t1.id, t2.id, t3.id].sort());
        expect(s.migratedIds).toEqual([m1.id, m2.id]); // oldest wait first
        expect(h.runpod.submit).toHaveBeenCalledTimes(2);

        for (const id of [t1.id, t2.id, t3.id]) expect((await row(id)).status).toBe('failed');
        const r1 = await row(m1.id);
        expect(r1).toMatchObject({ status: 'in_queue', isLocalJob: false, jobId: 'rp-mig-1', dequeuedAt: null });
        expect(r1.processingStartedAt.toISOString()).toBe(m1Started); // queue-start (daily quota accounting) is preserved
        expect(await row(m2.id)).toMatchObject({ status: 'in_queue', isLocalJob: false, jobId: 'rp-mig-2', dequeuedAt: null });
        for (const [i, v] of keepRows.entries()) expect(await row((v as any).id)).toEqual(snap[i]);

        // a second sweep changes nothing: migrated rows are in_queue (not processing), so no timeout can hit them
        const s2 = await runQueueSweep(realDeps());
        expect(s2).toMatchObject({ timedOut: 0, migrated: 0 });
        expect((await row(m1.id)).status).toBe('in_queue');
        expect(h.runpod.submit).toHaveBeenCalledTimes(2);
      });

      it('a migrated job that really starts and then times out is failed by a later sweep', async () => {
        const m = await local({ processing_started_at: iso(100) });
        await runQueueSweep(realDeps());
        expect((await row(m.id)).isLocalJob).toBe(false);
        await db.updateVideo(m.id, { status: 'processing', dequeued_at: iso(45) });
        const s = await runQueueSweep(realDeps());
        expect(s.timedOutIds).toEqual([m.id]);
        expect((await row(m.id)).status).toBe('failed');
      });

      it('submit failure resets the row to in_queue/local and the rest of the batch still migrates', async () => {
        const bad = await local({ processing_started_at: iso(100) });
        const good = await local({ processing_started_at: iso(90) });
        h.runpod.submit = vi.fn(async (_c: any, p: any) => {
          if (p.input.id === bad.id) throw new Error('runpod 500');
          return { id: 'rp-good' };
        });
        const s = await runQueueSweep(realDeps());
        expect(s).toMatchObject({ migrated: 1, migrationFailed: 1 });
        expect(await row(bad.id)).toMatchObject({ status: 'in_queue', isLocalJob: true, jobId: 'local-x', dequeuedAt: null });
        expect(await row(good.id)).toMatchObject({ status: 'in_queue', isLocalJob: false, jobId: 'rp-good' });
      });

      it('no callback base: timeouts still swept, nothing claimed or submitted', async () => {
        const t = await seed({ status: 'processing', processing_started_at: iso(200), job_id: 'rp-t', dequeued_at: iso(60) });
        const q = await local();
        const s = await runQueueSweep(realDeps({ resolveCallbackBase: () => null }));
        expect(s).toMatchObject({ timedOut: 1, migrated: 0, skipped: 'no-callback-base' });
        expect((await row(t.id)).status).toBe('failed');
        expect(await row(q.id)).toMatchObject({ status: 'in_queue', isLocalJob: true });
        expect(h.runpod.submit).not.toHaveBeenCalled();
      });

      it('honours freeUserWaitThresholdMinutes from AdminSettings', async () => {
        await db.updateAdminSettings({ freeUserWaitThresholdMinutes: 120 } as any);
        const q = await local({ processing_started_at: iso(100) });
        expect(await runQueueSweep(realDeps())).toMatchObject({ migrated: 0 });
        expect((await row(q.id)).isLocalJob).toBe(true);
        await db.updateAdminSettings({ freeUserWaitThresholdMinutes: 60 } as any);
        expect(await runQueueSweep(realDeps())).toMatchObject({ migrated: 1 });
      });

      it('two sweepers at once (multi-instance) migrate each row exactly once', async () => {
        const rows = await Promise.all(Array.from({ length: 5 }, () => local()));
        // runQueueSweep has an in-process re-entrancy flag, so emulate two instances at the DB layer
        const worker = async () => {
          const out: string[] = [];
          for (;;) {
            const c = await db.claimStaleLocalJob(ago(30));
            if (!c) return out;
            out.push(c.id);
          }
        };
        const [a, b] = await Promise.all([worker(), worker()]);
        expect([...a, ...b].sort()).toEqual(rows.map((r: any) => r.id).sort());
        expect(new Set([...a, ...b]).size).toBe(5);
      });
    });
  });
});
