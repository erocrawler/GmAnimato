import { beforeEach, describe, expect, it, vi } from 'vitest';

// The webhook handler is exercised against an in-memory video: no DB, no S3, no network.
const h = vi.hoisted(() => ({ video: null as any, updates: [] as any[] }));

vi.mock('$lib/db', () => ({
  getVideoById: async (id: string) => (h.video && h.video.id === id ? { ...h.video } : undefined),
  updateVideo: async (id: string, patch: any) => { h.updates.push(patch); h.video = { ...h.video, ...patch }; return h.video; },
}));
vi.mock('$lib/validation', () => ({ validateVideoEntry: () => [], formatValidationErrors: () => '' }));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => 'https://s3.test/uploaded.mp4' }));
vi.mock('$lib/serverImageUrl', () => ({ toProxiedUrl: (u: string) => u }));
vi.mock('$lib/ref2vPoster', () => ({ extractRef2VPosterFromResult: async () => null }));

import { POST } from '../src/routes/api/i2v-webhook/[id]/+server';

function call(id: string, body: any) {
  const request = new Request('http://x/api/i2v-webhook/' + id, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return POST({ request, params: { id } } as any);
}
const done = (url = 'https://evil.test/x.mp4') => ({ id: 'local-v1-abc', status: 'COMPLETED', files: [{ type: 's3_url', filename: 'a.mp4', data: url }] });

describe('i2v webhook', () => {
  beforeEach(() => { h.updates = []; h.video = { id: 'v1', job_id: 'local-v1-abc', status: 'processing', final_video_url: undefined }; });

  it('accepts the completion of a processing video', async () => {
    const res = await call('v1', done('https://s3.test/ok.mp4'));
    expect(res.status).toBe(201);
    expect(h.video.status).toBe('completed');
    expect(h.video.final_video_url).toBe('https://s3.test/ok.mp4');
  });

  it('rejects a wrong job id', async () => {
    const res = await call('v1', { ...done(), id: 'local-v1' });
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it('does not let a callback rewrite a completed video', async () => {
    h.video = { ...h.video, status: 'completed', final_video_url: '/media/real.mp4' };
    const res = await call('v1', done());
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(0);
    expect(h.video.final_video_url).toBe('/media/real.mp4');
  });

  it('does not let a callback flip a completed video to failed', async () => {
    h.video = { ...h.video, status: 'completed', final_video_url: '/media/real.mp4' };
    await call('v1', { id: 'local-v1-abc', status: 'FAILED' });
    expect(h.updates).toHaveLength(0);
    expect(h.video.status).toBe('completed');
  });

  it('ignores callbacks for a deleted video', async () => {
    h.video = { ...h.video, status: 'deleted' };
    await call('v1', done());
    expect(h.updates).toHaveLength(0);
  });

  it('accepts callbacks again once a retry put the video back to an active status', async () => {
    h.video = { ...h.video, status: 'in_queue' };
    const res = await call('v1', done('https://s3.test/second.mp4'));
    expect(res.status).toBe(201);
    expect(h.video.final_video_url).toBe('https://s3.test/second.mp4');
  });
});
