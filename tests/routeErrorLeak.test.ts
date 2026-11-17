import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level proof that an unexpected exception never reaches the response body
// (or a user-visible DB field): the secret is only ever written to the server log.
const SECRET = 'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2 at /srv/app/db.ts:42';
const FIXED = '服务器内部错误,请稍后重试';

const h = vi.hoisted(() => ({
  fail: true,
  updates: [] as any[],
  enhanceMsg: '',
  video: null as any,
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/db', () => ({
  getAdminSettings: async () => { if (h.fail) throw new Error(SECRET); return {}; },
  checkDailyQuota: async () => { throw new Error(SECRET); },
  toggleLike: async () => { throw new Error(SECRET); },
  getVideoById: async () => (h.video ? { ...h.video } : undefined),
  updateVideo: async (_id: string, patch: any) => { h.updates.push(patch); return {}; },
  completeVideoIfNotFinal: async () => { throw new Error(SECRET); },
}));
vi.mock('$lib/runpod', () => ({ getRunPodConfig: () => null, getRunPodHealth: async () => ({}) }));
vi.mock('$lib/imageRecognition', () => ({
  enhanceMiniMaxPrompt: async () => { throw new Error(h.enhanceMsg); },
}));
vi.mock('$lib/referenceImages', () => ({
  collectLabeledReferenceImages: async () => [],
  detectReferenceWorkflowType: () => 'i2v',
}));
vi.mock('$lib/validation', () => ({ validateVideoEntry: () => [], formatValidationErrors: () => '' }));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => '/media/x.mp4' }));
vi.mock('$lib/ref2vPoster', () => ({ extractRef2VPosterFromResult: async () => null }));

import { GET as quotaGET } from '../src/routes/api/quota/+server';
import { GET as healthGET } from '../src/routes/api/health/+server';
import { POST as likePOST } from '../src/routes/api/video/[id]/like/+server';
import { POST as enhancePOST } from '../src/routes/api/video/[id]/enhance-prompt/+server';
import { POST as webhookPOST } from '../src/routes/api/i2v-webhook/[id]/+server';

const user = { id: 'u1', roles: [] as string[] };

async function expectNoLeak(res: Response, status: number) {
  expect(res.status).toBe(status);
  const text = await res.text();
  for (const frag of ['ECONNREFUSED', 'hunter2', '/srv/app', '10.1.2.3', 'Error:']) expect(text).not.toContain(frag);
  return JSON.parse(text);
}

describe('routes do not echo raw exception text', () => {
  beforeEach(() => {
    h.fail = true; h.updates = []; h.video = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('GET /api/quota -> 500 with fixed message, detail logged', async () => {
    h.fail = true;
    const body = await expectNoLeak(await quotaGET({ locals: { user } } as any), 500);
    expect(body).toEqual({ error: FIXED });
    expect(console.error).toHaveBeenCalledWith('[API /quota] Error:', expect.objectContaining({ message: SECRET }));
  });

  it('GET /api/health -> 500 keeps availability fields, drops error text', async () => {
    const body = await expectNoLeak(await healthGET({} as any), 500);
    expect(body).toEqual({ available: false, queueFull: false, error: FIXED });
  });

  it('POST /api/video/[id]/like -> 500 with fixed message', async () => {
    const body = await expectNoLeak(await likePOST({ params: { id: 'v1' }, locals: { user } } as any), 500);
    expect(body.error).toBe(FIXED);
  });

  it('POST /api/i2v-webhook/[id] -> 500 with fixed message', async () => {
    h.video = { id: 'v1', job_id: 'local-v1-abc', status: 'processing' };
    const request = new Request('http://x/api/i2v-webhook/v1', {
      method: 'POST',
      body: JSON.stringify({ id: 'local-v1-abc', status: 'FAILED' }),
      headers: { 'content-type': 'application/json' },
    });
    const body = await expectNoLeak(await webhookPOST({ request, params: { id: 'v1' } } as any), 500);
    expect(body.error).toBe(FIXED);
  });

  describe('enhance-prompt', () => {
    const call = () => {
      h.video = { id: 'v1', user_id: 'u1', status: 'draft' };
      const request = new Request('http://x/api/video/v1/enhance-prompt', {
        method: 'POST', body: JSON.stringify({ prompt: 'a cat' }), headers: { 'content-type': 'application/json' },
      });
      return enhancePOST({ params: { id: 'v1' }, request, locals: { user } } as any);
    };

    it('generic upstream error -> 502 with fixed message', async () => {
      h.enhanceMsg = SECRET;
      const body = await expectNoLeak(await call(), 502);
      expect(body).toEqual({ success: false, error: '提示词增强失败,请稍后重试' });
    });

    it('context-size error keeps the actionable fixed hint, not the raw text', async () => {
      h.enhanceMsg = 'request (9000 tokens) exceeds the available context size (8192 tokens) at http://10.1.2.3:8080';
      const res = await call();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('超出模型上下文窗口');
      expect(text).not.toContain('10.1.2.3');
      expect(text).not.toContain('8192');
    });
  });
});
