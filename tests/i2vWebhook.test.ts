import { beforeEach, describe, expect, it, vi } from 'vitest';

// The webhook handler is exercised against an in-memory video: no DB, no S3, no network.
const h = vi.hoisted(() => ({ video: null as any, updates: [] as any[], env: {} as Record<string, string | undefined>, uploads: 0 }));

vi.mock('$lib/db', () => ({
  getVideoById: async (id: string) => (h.video && h.video.id === id ? { ...h.video } : undefined),
  updateVideo: async (id: string, patch: any) => { h.updates.push(patch); h.video = { ...h.video, ...patch }; return h.video; },
}));
vi.mock('$lib/validation', () => ({ validateVideoEntry: () => [], formatValidationErrors: () => '' }));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => { h.uploads++; return '/media/b/uploaded.mp4'; } }));
vi.mock('$env/dynamic/private', () => ({ env: h.env }));
vi.mock('$lib/ref2vPoster', () => ({ extractRef2VPosterFromResult: async () => null }));

import { POST } from '../src/routes/api/i2v-webhook/[id]/+server';

function call(id: string, body: any) {
  const request = new Request('http://x/api/i2v-webhook/' + id, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return POST({ request, params: { id } } as any);
}
const done = (url = 'https://evil.test/x.mp4') => ({ id: 'local-v1-abc', status: 'COMPLETED', files: [{ type: 's3_url', filename: 'a.mp4', data: url }] });

describe('i2v webhook', () => {
  beforeEach(() => { h.updates = []; h.uploads = 0; h.env.S3_ENDPOINT = 'https://s3.test'; delete h.env.S3_ALLOWED_URL_PREFIXES; h.video = { id: 'v1', job_id: 'local-v1-abc', status: 'processing', final_video_url: undefined }; });

  it('accepts the completion of a processing video', async () => {
    const res = await call('v1', done('https://s3.test/ok.mp4'));
    expect(res.status).toBe(201);
    expect(h.video.status).toBe('completed');
    expect(h.video.final_video_url).toBe('/media/ok.mp4');
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
    expect(h.video.final_video_url).toBe('/media/second.mp4');
  });

  describe('result video address', () => {
    it('converts an address under S3_ENDPOINT to its /media/ path', async () => {
      await call('v1', done('https://s3.test/wan/out_01.mp4'));
      expect(h.video.status).toBe('completed');
      expect(h.video.final_video_url).toBe('/media/wan/out_01.mp4');
    });

    it('accepts an in-site /media/ path as-is', async () => {
      await call('v1', done('/media/wan/out.webm'));
      expect(h.video.status).toBe('completed');
      expect(h.video.final_video_url).toBe('/media/wan/out.webm');
    });

    it('ignores an external address: the completion ends up failed with no url', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const url of ['https://evil.test/x.mp4', 'http://127.0.0.1:3999/x.mp4', 'file:///etc/passwd', '//evil.test/x.mp4',
        'https://s3.test.evil.test/x.mp4', 'https://s3.test@evil.test/x.mp4', '/media/../etc/x.mp4', 'https://s3.test/../x.mp4']) {
        h.updates = [];
        h.video = { id: 'v1', job_id: 'local-v1-abc', status: 'processing', final_video_url: undefined };
        const res = await call('v1', done(url));
        expect(res.status, url).toBe(201);
        expect(h.video.status, url).toBe('failed');
        expect(h.video.final_video_url, url).toBeUndefined();
      }
      warn.mockRestore();
    });

    it('a rejected address is logged by host only, never with its path or query string', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await call('v1', done('https://evil.test/secret/path.mp4?X-Amz-Signature=topsecret&token=abc'));
      const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      warn.mockRestore();
      expect(logged).toContain('evil.test');
      expect(logged).not.toContain('topsecret');
      expect(logged).not.toContain('X-Amz');
      expect(logged).not.toContain('secret/path');
    });

    it('S3_ALLOWED_URL_PREFIXES adds trusted prefixes, stored as given', async () => {
      h.env.S3_ALLOWED_URL_PREFIXES = ' https://cdn.test/wan , https://other.test/ ';
      await call('v1', done('https://cdn.test/wan/a.mp4'));
      expect(h.video.status).toBe('completed');
      expect(h.video.final_video_url).toBe('https://cdn.test/wan/a.mp4');
    });

    it('extra prefixes match whole path segments / hosts only', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.env.S3_ALLOWED_URL_PREFIXES = 'https://cdn.test/wan';
      for (const url of ['https://cdn.test/wanx/a.mp4', 'https://cdn.test.evil.test/wan/a.mp4', 'https://cdn.test/wan/../x.mp4', 'https://cdn.test/wan/']) {
        h.video = { id: 'v1', job_id: 'local-v1-abc', status: 'processing', final_video_url: undefined };
        await call('v1', done(url));
        expect(h.video.status, url).toBe('failed');
      }
      vi.restoreAllMocks();
    });

    it('without S3_ENDPOINT nothing but /media/ paths and extra prefixes is accepted', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.env.S3_ENDPOINT = undefined;
      await call('v1', done('https://s3.test/ok.mp4'));
      expect(h.video.status).toBe('failed');
      vi.restoreAllMocks();
    });

    it('a later valid file wins over an earlier rejected one', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await call('v1', { id: 'local-v1-abc', status: 'COMPLETED', files: [
        { type: 's3_url', filename: 'a.mp4', data: 'https://evil.test/a.mp4' },
        { type: 's3_url', filename: 'b.mp4', data: 'https://s3.test/wan/b.mp4' },
      ] });
      expect(h.video.final_video_url).toBe('/media/wan/b.mp4');
      vi.restoreAllMocks();
    });

    it('base64 payload upload is unaffected', async () => {
      await call('v1', { id: 'local-v1-abc', status: 'COMPLETED', files: [{ type: 'base64', filename: 'a.mp4', data: Buffer.from('abc').toString('base64') }] });
      expect(h.uploads).toBe(1);
      expect(h.video.status).toBe('completed');
      expect(h.video.final_video_url).toBe('/media/b/uploaded.mp4');
    });

    it('an external s3_url is not rescued by a base64 file, and does not block it either', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await call('v1', { id: 'local-v1-abc', status: 'COMPLETED', files: [
        { type: 's3_url', filename: 'a.mp4', data: 'https://evil.test/a.mp4' },
        { type: 'base64', filename: 'b.mp4', data: Buffer.from('abc').toString('base64') },
      ] });
      expect(h.video.final_video_url).toBe('/media/b/uploaded.mp4');
      vi.restoreAllMocks();
    });
  });
});
