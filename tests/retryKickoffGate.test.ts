import { beforeEach, describe, expect, it, vi } from 'vitest';

// kickoff / retry / reopen run against an in-memory DB: no Postgres, no RunPod, no network.
// The daily-credit count mirrors the real backend: only rows with a processing_started_at
// today in an active/completed status are charged.
const h = vi.hoisted(() => ({
  videos: {} as Record<string, any>,
  users: {} as Record<string, any>,
  workflows: {} as Record<string, any>,
  settings: {} as any,
  updates: [] as { id: string; patch: any }[],
  runpod: { submit: null as any, retry: null as any, status: null as any } as Record<'submit' | 'retry' | 'status', any>,
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/db', () => {
  const activeStatuses = ['completed', 'in_queue', 'processing'];
  const quotaUsed = (userId: string) => {
    const today = new Date().toDateString();
    return Object.values(h.videos)
      .filter((v: any) => v.user_id === userId && v.processing_started_at
        && new Date(v.processing_started_at).toDateString() === today && activeStatuses.includes(v.status))
      .reduce((n: number, v: any) => n + (v.quota_cost ?? 1), 0);
  };
  return {
    getVideoById: async (id: string) => (h.videos[id] ? { ...h.videos[id] } : undefined),
    updateVideo: async (id: string, patch: any) => {
      h.updates.push({ id, patch });
      const next = { ...h.videos[id] };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v; // Postgres backend skips undefined
      h.videos[id] = next;
      return { ...next };
    },
    getAdminSettings: async () => h.settings,
    getUserById: async (id: string) => h.users[id],
    getWorkflowById: async (id: string) => h.workflows[id],
    getDefaultWorkflow: async () => h.workflows.w1,
    getLocalJobStats: async () => ({ inQueue: 0 }),
    claimJobForMigration: async () => null,
    getActiveJobCountByUser: async (userId: string) =>
      Object.values(h.videos).filter((v: any) => v.user_id === userId && ['in_queue', 'processing'].includes(v.status)).length,
    checkDailyQuota: async (user: any, settings: any, cost = 1) => {
      let limit = 0;
      for (const r of user.roles) if (settings.quotaPerDay[r] !== undefined) limit += settings.quotaPerDay[r];
      const used = quotaUsed(user.id);
      return { exceeded: used + cost > limit, limit, used, cost };
    },
    isUserPaid: (user: any, settings: any) =>
      user.roles.some((r: string) => settings.roles?.find((rc: any) => rc.name === r)?.allowAdvancedFeatures === true),
  };
});
vi.mock('$lib/runpod', () => ({
  getRunPodConfig: () => ({ url: 'http://runpod.test', key: 'k' }),
  getRunPodHealth: async () => ({ jobs: { inQueue: 0 } }),
  getRunPodJobStatus: (...a: any[]) => h.runpod.status(...a),
  mapRunPodStatus: (s: string) => ({ FAILED: 'failed', COMPLETED: 'completed', IN_QUEUE: 'in_queue', IN_PROGRESS: 'processing' } as any)[s] ?? 'failed',
  retryRunPodJob: (...a: any[]) => h.runpod.retry(...a),
  submitRunPodJob: (...a: any[]) => h.runpod.submit(...a),
}));
vi.mock('$lib/jobWorkflow', () => ({
  buildJobWorkflow: async () => ({ payload: { input: {} } }),
  getCallbackUrl: (origin: string, id: string) => `${origin}/api/i2v-webhook/${id}`,
}));
vi.mock('$lib/local-queue', () => ({
  submitJob: async () => ({ jobId: 'runpod-new-1', isLocal: false }),
}));
vi.mock('$lib/imageRecognition', () => ({ evaluatePromptProperties: async () => ({}) }));
vi.mock('$lib/serverImageUrl', () => ({ toOriginalUrl: (u: string) => u }));

import { POST as retry } from '../src/routes/api/video/[id]/retry/+server';
import { POST as reopen } from '../src/routes/api/video/[id]/reopen/+server';
import { POST as kickoff } from '../src/routes/api/i2v/kickoff/+server';

const FREE = { id: 'u-free', roles: ['free'] };
const PAID = { id: 'u-paid', roles: ['paid'] };
const ADMIN = { id: 'u-admin', roles: ['admin'] };

const failedVideo = (over: any = {}) => ({
  id: 'v1', user_id: FREE.id, status: 'failed', job_id: 'rp-old', is_local_job: false,
  workflow_id: 'w1', quota_cost: 1, iteration_steps: 4, video_resolution: '480p',
  prompt: 'p', original_image_url: 'https://x/a.png',
  dequeued_at: '2020-01-01T00:00:00.000Z', processing_started_at: '2020-01-01T00:00:00.000Z',
  ...over,
});

const callRetry = (user: any, id = 'v1') =>
  retry({ params: { id }, request: new Request('http://x/api/video/' + id + '/retry', { method: 'POST' }), locals: { user } } as any);
const callReopen = (user: any, id = 'v1') =>
  reopen({ params: { id }, locals: { user } } as any);
const callKickoff = (user: any, body: any) =>
  kickoff({ request: new Request('http://x/api/i2v/kickoff', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), locals: { user } } as any);

beforeEach(() => {
  h.updates = [];
  h.videos = {};
  h.users = { [FREE.id]: FREE, [PAID.id]: PAID, [ADMIN.id]: ADMIN };
  h.workflows = { w1: { id: 'w1', name: 'Wan', workflowType: 'i2v', quotaCost: 1, templatePath: 'wan.json', capabilities: { steps: [4, 6], resolutions: ['480p', '720p', '720p-hd'], freeSteps: 4 } } };
  h.settings = {
    roles: [{ name: 'free' }, { name: 'paid', allowAdvancedFeatures: true }, { name: 'admin', allowAdvancedFeatures: true }],
    quotaPerDay: { free: 2, paid: 10, admin: 10 },
    freeUserQueueLimit: 3, paidUserQueueLimit: 5, maxQueueThreshold: 100, loraPresets: [],
  };
  h.runpod.submit = vi.fn(async () => ({ id: 'rp-new' }));
  h.runpod.retry = vi.fn(async () => ({}));
  h.runpod.status = vi.fn(async () => ({ status: 'FAILED' }));
});

describe('retry: same gates as kickoff', () => {
  it('429 quota_exceeded and no RunPod submission for a user out of credits', async () => {
    h.videos.v1 = failedVideo({ is_local_job: true });
    // two credits already burned today (limit 2)
    h.videos.a = { id: 'a', user_id: FREE.id, status: 'completed', quota_cost: 2, processing_started_at: new Date().toISOString() };
    const res = await callRetry(FREE);
    expect(res.status).toBe(429);
    expect((await res.json()).errorCode).toBe('quota_exceeded');
    expect(h.runpod.submit).not.toHaveBeenCalled();
    expect(h.runpod.retry).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it('429 quota_none for a role with no daily credits (original-job retry path too)', async () => {
    h.settings.quotaPerDay.free = 0;
    h.videos.v1 = failedVideo();
    const res = await callRetry(FREE);
    expect(res.status).toBe(429);
    expect((await res.json()).errorCode).toBe('quota_none');
    expect(h.runpod.retry).not.toHaveBeenCalled();
  });

  it('403 for a stored 720p-hd video when the owner has no advanced features (local→RunPod path)', async () => {
    h.videos.v1 = failedVideo({ is_local_job: true, video_resolution: '720p-hd' });
    const res = await callRetry(FREE);
    expect(res.status).toBe(403);
    expect(h.runpod.submit).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it('403 for stored premium steps (original-job retry path)', async () => {
    h.videos.v1 = failedVideo({ iteration_steps: 6 });
    const res = await callRetry(FREE);
    expect(res.status).toBe(403);
    expect(h.runpod.retry).not.toHaveBeenCalled();
  });

  it('403 for stored premium steps on the 404-resubmit path', async () => {
    h.videos.v1 = failedVideo({ iteration_steps: 6 });
    h.runpod.status = vi.fn(async () => { throw new Error('RunPod status 404'); });
    const res = await callRetry(FREE);
    expect(res.status).toBe(403);
    expect(h.runpod.submit).not.toHaveBeenCalled();
  });

  it('a workflow with freeSteps=8 keeps 8 steps free', async () => {
    h.workflows.w1.capabilities = { steps: [4, 8], resolutions: ['480p'], freeSteps: 8 };
    h.videos.v1 = failedVideo({ iteration_steps: 8 });
    const res = await callRetry(FREE);
    expect(res.status).toBe(200);
  });

  it('403 for stored relay frames above the free cap', async () => {
    h.videos.v1 = failedVideo({ additional_options: { prompt_relay_mode: true, prompt_relay_segments: [{ prompt: 'a', frames: 100 }, { prompt: 'b', frames: 77 }] } });
    const res = await callRetry(FREE);
    expect(res.status).toBe(403);
    expect(h.runpod.retry).not.toHaveBeenCalled();
  });

  it('429 queue_limit when the owner already has too many active jobs', async () => {
    h.videos.v1 = failedVideo();
    for (const n of ['q1', 'q2', 'q3']) h.videos[n] = { id: n, user_id: FREE.id, status: 'in_queue' };
    const res = await callRetry(FREE);
    expect(res.status).toBe(429);
    expect((await res.json()).errorCode).toBe('queue_limit');
    expect(h.runpod.retry).not.toHaveBeenCalled();
  });

  it('an admin retrying someone else\'s video is gated as the video owner, not as the admin', async () => {
    h.videos.v1 = failedVideo({ is_local_job: true, video_resolution: '720p-hd' });
    const res = await callRetry(ADMIN); // admin has advanced features, owner (free) does not
    expect(res.status).toBe(403);
    expect(h.runpod.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['local job → RunPod', { is_local_job: true }, (): void => undefined],
    ['404 resubmit', {}, (): void => { h.runpod.status = vi.fn(async () => { throw new Error('RunPod status 404'); }); }],
    ['original-job retry', {}, (): void => undefined],
  ] as [string, any, () => void][])('succeeds for a normal video and stamps processing_started_at (%s)', async (_n, over, setup) => {
    h.videos.v1 = failedVideo(over);
    setup();
    const before = Date.now();
    const res = await callRetry(FREE);
    expect(res.status).toBe(200);
    const v = h.videos.v1;
    expect(v.status).toBe('in_queue');
    expect(Date.parse(v.processing_started_at)).toBeGreaterThanOrEqual(before);
    expect(v.dequeued_at).toBeNull();
    const second = await callRetry(FREE); // video is in_queue now → not retried again
    expect(second.status).toBe(400);
  });

  it('a retried attempt counts toward the daily credits', async () => {
    h.videos.v1 = failedVideo({ id: 'v1' });
    h.videos.v2 = failedVideo({ id: 'v2', quota_cost: 1 });
    expect((await callRetry(FREE, 'v1')).status).toBe(200);
    expect((await callRetry(FREE, 'v2')).status).toBe(200);
    h.videos.v3 = failedVideo({ id: 'v3', quota_cost: 1 });
    const res = await callRetry(FREE, 'v3'); // limit 2, already 2 charged
    expect(res.status).toBe(429);
  });

  it('a paid user may retry a 720p-hd / 6-step video', async () => {
    h.videos.v1 = failedVideo({ user_id: PAID.id, video_resolution: '720p-hd', iteration_steps: 6 });
    const res = await callRetry(PAID);
    expect(res.status).toBe(200);
  });
});

describe('reopen', () => {
  it('clears job_id and is_local_job so retry has nothing stale to run', async () => {
    h.videos.v1 = failedVideo({ is_local_job: true });
    const res = await callReopen(FREE);
    expect(res.status).toBe(200);
    expect(h.videos.v1.status).toBe('uploaded');
    expect(h.videos.v1.job_id).toBeNull();
    expect(h.videos.v1.is_local_job).toBe(false);
    expect(h.videos.v1.processing_started_at).toBeNull();
    // and retry now refuses it
    expect((await callRetry(FREE)).status).toBe(400);
  });
});

describe('kickoff: cost/tier-defining fields are persisted only after the gates pass', () => {
  const uploaded = (over: any = {}) => ({
    id: 'v1', user_id: FREE.id, status: 'uploaded', prompt: 'old prompt',
    original_image_url: 'https://x/a.png', iteration_steps: 4, video_resolution: '480p', quota_cost: 1,
    ...over,
  });
  const gatedKeys = ['workflow_id', 'quota_cost', 'iteration_steps', 'video_duration', 'video_resolution', 'additional_options', 'lora_weights', 'seed'];

  it('403 for 720p-hd without advanced features: gated fields untouched, prompt saved', async () => {
    h.videos.v1 = uploaded();
    const res = await callKickoff(FREE, { id: 'v1', prompt: 'new prompt', videoResolution: '720p-hd' });
    expect(res.status).toBe(403);
    expect(h.videos.v1.prompt).toBe('new prompt');
    expect(h.videos.v1.video_resolution).toBe('480p');
    expect(h.videos.v1.iteration_steps).toBe(4);
    for (const { patch } of h.updates) for (const k of gatedKeys) expect(patch).not.toHaveProperty(k);
  });

  it('403 for premium steps: nothing gated saved', async () => {
    h.videos.v1 = uploaded();
    const res = await callKickoff(FREE, { id: 'v1', prompt: 'new prompt', iterationSteps: 6 });
    expect(res.status).toBe(403);
    expect(h.videos.v1.iteration_steps).toBe(4);
    expect(h.videos.v1.prompt).toBe('new prompt');
  });

  it('429 over quota: nothing gated saved, prompt kept', async () => {
    h.settings.quotaPerDay.free = 0;
    h.videos.v1 = uploaded();
    const res = await callKickoff(FREE, { id: 'v1', prompt: 'new prompt', tags: ['t'] });
    expect(res.status).toBe(429);
    expect((await res.json()).errorCode).toBe('quota_none');
    expect(h.videos.v1.prompt).toBe('new prompt');
    expect(h.videos.v1.tags).toEqual(['t']);
    expect(h.videos.v1.quota_cost).toBe(1);
    expect(h.videos.v1.workflow_id).toBeUndefined();
    for (const { patch } of h.updates) for (const k of gatedKeys) expect(patch).not.toHaveProperty(k);
  });

  it('429 queue_limit: nothing gated saved', async () => {
    h.videos.v1 = uploaded();
    for (const n of ['q1', 'q2', 'q3']) h.videos[n] = { id: n, user_id: FREE.id, status: 'in_queue' };
    const res = await callKickoff(FREE, { id: 'v1', prompt: 'p2' });
    expect(res.status).toBe(429);
    expect(h.videos.v1.workflow_id).toBeUndefined();
    for (const { patch } of h.updates) for (const k of gatedKeys) expect(patch).not.toHaveProperty(k);
  });

  it('success path stores the gated fields together with in_queue + processing_started_at', async () => {
    h.videos.v1 = uploaded();
    const res = await callKickoff(PAID, { id: 'v1', prompt: 'go', videoResolution: '720p-hd', iterationSteps: 6 });
    expect(res.status).toBe(403); // owned by FREE: not the caller
    h.videos.v1 = uploaded({ user_id: PAID.id });
    const ok = await callKickoff(PAID, { id: 'v1', prompt: 'go', videoResolution: '720p-hd', iterationSteps: 6 });
    expect(ok.status).toBe(200);
    expect(h.videos.v1).toMatchObject({ prompt: 'go', workflow_id: 'w1', video_resolution: '720p-hd', iteration_steps: 6, status: 'in_queue' });
    expect(h.videos.v1.processing_started_at).toBeTruthy();
  });
});
