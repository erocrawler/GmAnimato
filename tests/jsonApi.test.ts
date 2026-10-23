import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  videos: [] as any[],
  workflows: [] as any[],
  settings: {} as any,
  createDraft: vi.fn(),
  lastListArgs: null as any,
}));

vi.mock('$lib/db', () => ({
  getVideoById: async (id: string) => h.videos.find((v) => v.id === id),
  deleteVideo: async () => true,
  getVideosByUser: async (userId: string, page: number, pageSize: number, options: any) => {
    h.lastListArgs = { userId, page, pageSize, options };
    const mine = h.videos.filter((v) => v.user_id === userId && v.status !== 'deleted');
    return { videos: mine, total: mine.length, page, pageSize, totalPages: Math.ceil(mine.length / pageSize) };
  },
  getWorkflows: async () => h.workflows,
  getAdminSettings: async () => h.settings,
}));
vi.mock('$lib/uploadForm', () => ({ createDraftFromUploadForm: h.createDraft }));
vi.mock('$lib/serverImageUrl', () => ({ toProxiedUrl: (u: string) => u.replace('https://s3.test', '/media'), toOriginalUrl: (u: string) => u }));

import { GET as getWorkflows } from '../src/routes/api/workflows/+server';
import { GET as getVideos } from '../src/routes/api/videos/+server';
import { GET as getVideo } from '../src/routes/api/video/[id]/+server';
import { POST as postUpload } from '../src/routes/api/uploads/+server';

const alice = { id: 'u1', username: 'alice', roles: ['free'], created_at: 'x' };
const bob = { id: 'u2', username: 'bob', roles: ['free'], created_at: 'x' };
const admin = { id: 'u9', username: 'root', roles: ['admin'], created_at: 'x' };

const video = (over: any = {}) => ({
  id: 'vid1', user_id: 'u1', status: 'completed', original_image_url: 'https://s3.test/b/in.png',
  prompt: 'hi', final_video_url: '/media/b/out.mp4', created_at: '2026-01-01T00:00:00Z', quota_cost: 1,
  additional_options: { ref2v: true, ref_video_url: 'https://s3.test/b/ref.mp4', secret_internal: 'nope' },
  job_id: 'runpod-123', ...over,
});

const workflow = (over: any = {}) => ({
  id: 'wf1', name: 'H3 ref2v', workflowType: 'ref2v', templatePath: 'x_minimax.json.tmpl', engine: 'minimax',
  compatibleLoraIds: ['turbo.safetensors', 'style.safetensors'], isDefault: true, isDeleted: false, quotaCost: 2,
  quotaCostRules: [], capabilities: { steps: [4, 8], durations: [4, 6, 10, 15], resolutions: ['480p', '720p'], freeSteps: 8 },
  createdAt: 'x', updatedAt: 'x', ...over,
});

beforeEach(() => {
  h.videos = [video()];
  h.workflows = [workflow(), workflow({ id: 'wf2', name: 'old', workflowType: 'i2v', engine: 'wan', capabilities: {}, isDeleted: true })];
  h.settings = {
    roles: [{ name: 'paid', allowAdvancedFeatures: true }],
    loraPresets: [
      { id: 'turbo.safetensors', label: 'Turbo', default: 1, isConfigurable: false },
      { id: 'style.safetensors', label: 'Style', default: 0.5, isConfigurable: true },
    ],
  };
  h.createDraft.mockReset();
});

describe('GET /api/workflows', () => {
  it('describes resolved capabilities, premium flags, required LoRAs and cost; hides deleted workflows', async () => {
    const res = await getWorkflows({ url: new URL('https://t/api/workflows'), locals: { user: alice } } as any);
    const j = await res.json();
    expect(j.workflows).toHaveLength(1);
    const w = j.workflows[0];
    expect(w).toMatchObject({ id: 'wf1', type: 'ref2v', engine: 'minimax', quota_cost: 2, is_default: true, free_steps: 8 });
    expect(w.steps).toEqual([4, 8]);
    expect(w.premium.steps).toEqual([]);
    expect(w.premium.durations).toEqual([10, 15]);
    expect(w.premium.resolutions).toEqual(['720p']);
    expect(w.premium.requires_advanced_role).toBe(true);
    expect(w.allowed_for_user).toEqual({ steps: [4, 8], durations: [4, 6], resolutions: ['480p'] });
    expect(w.required_loras.map((l: any) => l.id)).toEqual(['turbo.safetensors']);
    expect(w.optional_loras.map((l: any) => l.id)).toEqual(['style.safetensors']);
    expect(j.user).toEqual({ has_advanced_features: false, max_duration_seconds: 6 });
  });

  it('unlocks premium values for advanced roles and filters by type', async () => {
    const paid = { ...alice, roles: ['paid'] };
    const j = await (await getWorkflows({ url: new URL('https://t/api/workflows?type=ref2v'), locals: { user: paid } } as any)).json();
    expect(j.workflows[0].allowed_for_user).toEqual({ steps: [4, 8], durations: [4, 6, 10, 15], resolutions: ['480p', '720p'] });
    expect(j.user.max_duration_seconds).toBe(15);
    const none = await (await getWorkflows({ url: new URL('https://t/api/workflows?type=i2v'), locals: { user: alice } } as any)).json();
    expect(none.workflows).toEqual([]);
  });

  it('rejects an unknown type and anonymous callers', async () => {
    expect((await getWorkflows({ url: new URL('https://t/api/workflows?type=zzz'), locals: { user: alice } } as any)).status).toBe(400);
    expect((await getWorkflows({ url: new URL('https://t/api/workflows'), locals: {} } as any)).status).toBe(401);
  });
});

describe('GET /api/videos', () => {
  it('lists only the caller\'s videos with pagination metadata and no internal fields', async () => {
    h.videos.push(video({ id: 'other', user_id: 'u2' }));
    const j = await (await getVideos({ url: new URL('https://t/api/videos?page=2&page_size=500'), locals: { user: alice } } as any)).json();
    expect(h.lastListArgs).toMatchObject({ userId: 'u1', page: 2, pageSize: 50 }); // clamped
    expect(j.videos.map((v: any) => v.id)).toEqual(['vid1']);
    expect(JSON.stringify(j)).not.toContain('runpod-123');
    expect(j).toMatchObject({ page: 2, page_size: 50, total: 1 });
    expect(j.videos[0]).toMatchObject({ mode: 'ref2v', status: 'completed', final_video_url: '/media/b/out.mp4' });
  });

  it('validates filters', async () => {
    const call = (q: string) => getVideos({ url: new URL(`https://t/api/videos?${q}`), locals: { user: alice } } as any);
    expect((await call('status=bogus')).status).toBe(400);
    expect((await call('sort=bogus')).status).toBe(400);
    expect((await call('direction=up')).status).toBe(400);
    expect((await call('status=completed&sort=completion&direction=asc')).status).toBe(200);
    expect(h.lastListArgs.options).toEqual({ status: 'completed', sortBy: 'completion', sortDirection: 'asc' });
  });
});

describe('GET /api/video/{id}', () => {
  const call = (user: any, id = 'vid1') => getVideo({ params: { id }, locals: { user } } as any);

  it('returns detail (proxied urls, whitelisted options only) to the owner', async () => {
    const j = await (await call(alice)).json();
    expect(j.id).toBe('vid1');
    expect(j.options.ref_video_url).toBe('/media/b/ref.mp4');
    expect(j.original_image_url).toBe('/media/b/in.png');
    expect(j.options.secret_internal).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain('runpod-123');
  });

  it('is 404 (not 403) for other users, missing and deleted videos; admin may read', async () => {
    expect((await call(bob)).status).toBe(404);
    expect((await call(alice, 'nope')).status).toBe(404);
    h.videos[0].status = 'deleted';
    expect((await call(alice)).status).toBe(404);
    h.videos[0].status = 'completed';
    expect((await call(admin)).status).toBe(200);
    expect((await call(undefined)).status).toBe(401);
  });
});

describe('POST /api/uploads', () => {
  const entry = { id: 'new1', user_id: 'u1', status: 'uploaded', original_image_url: 'https://s3.test/b/x.png', created_at: 'x' };

  it('multipart: delegates to the shared form handler in API mode and returns the draft', async () => {
    h.createDraft.mockResolvedValue({ success: true, entry });
    const fd = new FormData();
    fd.set('mode', 'i2v');
    fd.set('image', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const request = new Request('https://t/api/uploads', { method: 'POST', body: fd });
    const res = await postUpload({ request, locals: { user: alice } } as any);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j).toMatchObject({ success: true, id: 'new1', status: 'uploaded', mode: 'i2v' });
    expect(h.createDraft).toHaveBeenCalledTimes(1);
    expect(h.createDraft.mock.calls[0][1]).toBe(alice);
    expect(h.createDraft.mock.calls[0][2]).toEqual({ apiMode: true });
  });

  it('json: only scalar fields are forwarded (no files)', async () => {
    h.createDraft.mockResolvedValue({ success: true, entry });
    const request = new Request('https://t/api/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ref2v', ref_video_url: '/media/b/ref.mp4', nested: { a: 1 }, list: [1] }),
    });
    await postUpload({ request, locals: { user: alice } } as any);
    const form: FormData = h.createDraft.mock.calls[0][0];
    expect(form.get('mode')).toBe('ref2v');
    expect(form.get('ref_video_url')).toBe('/media/b/ref.mp4');
    expect(form.has('nested')).toBe(false);
    expect(form.has('list')).toBe(false);
  });

  it('maps validation failures to 400 upload_invalid, bad content types to 415, anonymous to 401', async () => {
    h.createDraft.mockResolvedValue({ error: 'First image: too small' });
    const fd = new FormData();
    fd.set('mode', 'i2v');
    const bad = await postUpload({ request: new Request('https://t/api/uploads', { method: 'POST', body: fd }), locals: { user: alice } } as any);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'First image: too small', errorCode: 'upload_invalid' });

    const txt = await postUpload({ request: new Request('https://t/api/uploads', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }), locals: { user: alice } } as any);
    expect(txt.status).toBe(415);
    const anon = await postUpload({ request: new Request('https://t/api/uploads', { method: 'POST', body: fd }), locals: {} } as any);
    expect(anon.status).toBe(401);
  });
});
