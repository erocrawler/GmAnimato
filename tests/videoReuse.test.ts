import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('$lib/videoEntryCreation', () => ({ createVideoEntryForReview: h.create }));

import { POST } from '../src/routes/api/video/reuse/+server';

async function call(body: any, user: any = { id: 'u1' }) {
  const request = new Request('http://x/api/video/reuse', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await POST({ request, locals: { user } } as any);
  return { status: res.status, json: await res.json() };
}

const BAD = ['http://evil.example/a.png', 'https://evil.example/a.png', 'http://127.0.0.1:3999/x', 'file:///etc/passwd', '//evil/x',
  '/media/../x', '/media/a/../../x', '../media/x', '/uploads/x.png', 'javascript:alert(1)', '/media/a?x=1', 12345, { a: 1 }];

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ success: true, entry: { id: 'e1' } });
});

describe('POST /api/video/reuse', () => {
  it('requires a session', async () => {
    expect((await call({ originalImageUrl: '/media/b/a.png' }, null)).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('rejects anything but a /media/... originalImageUrl with 400', async () => {
    for (const url of BAD) {
      const r = await call({ mode: 'i2v', originalImageUrl: url });
      expect(r.status, String(url)).toBe(400);
      expect(r.json.error).toBe('originalImageUrl must be a /media/... path');
    }
    expect((await call({ mode: 'i2v' })).json.error).toBe('missing originalImageUrl');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('rejects a bad lastImageUrl, accepts none for i2v, and still requires it for fl2v', async () => {
    for (const url of BAD) {
      const r = await call({ mode: 'fl2v', originalImageUrl: '/media/b/a.png', lastImageUrl: url });
      expect(r.status, String(url)).toBe(400);
      expect(r.json.error).toBe('lastImageUrl must be a /media/... path');
    }
    expect((await call({ mode: 'i2v', originalImageUrl: '/media/b/a.png', lastImageUrl: 'http://evil.example/x.png' })).status).toBe(400);
    const missing = await call({ mode: 'fl2v', originalImageUrl: '/media/b/a.png' });
    expect(missing).toEqual({ status: 400, json: { error: 'missing lastImageUrl for fl2v mode' } });
    expect(h.create).not.toHaveBeenCalled();

    const ok = await call({ mode: 'i2v', originalImageUrl: '/media/b/a.png' });
    expect(ok.status).toBe(200);
    expect(h.create.mock.calls[0][0].lastImageUrl).toBeUndefined();
  });

  it('accepts /media paths and absolute in-site /media urls, passing the normalised values on', async () => {
    const r = await call({
      mode: 'fl2v',
      originalImageUrl: 'https://animato.example/media/wan/first.png',
      lastImageUrl: ' /media/wan/last.png ',
      prompt: 'p',
    });
    expect(r.status).toBe(200);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', mode: 'fl2v', originalImageUrl: '/media/wan/first.png', lastImageUrl: '/media/wan/last.png',
    }));
  });

  it('still validates additionalOptions.ref_video_url, and the other stored ref urls the server later fetches', async () => {
    for (const additionalOptions of [
      { ref_video_url: 'http://evil.example/v.mp4' },
      { ref_audio_url: 'http://evil.example/a.wav' },
      { ref_image_urls: ['/media/b/ok.png', 'http://evil.example/i.png'] },
      { ref_image_urls: 'http://evil.example/i.png' },
      { ref_image_urls: Array(7).fill('/media/b/ok.png') },
    ]) {
      const r = await call({ mode: 'ref2v', originalImageUrl: '/media/b/a.png', additionalOptions });
      expect(r.status, JSON.stringify(additionalOptions)).toBe(400);
    }
    expect(h.create).not.toHaveBeenCalled();

    const ok = await call({
      mode: 'ref2v', originalImageUrl: '/media/b/a.png',
      additionalOptions: { ref2v: true, ref_video_url: 'https://animato.example/media/wan/v.mp4', ref_audio_url: '/media/b/a.wav', ref_image_urls: ['/media/b/1.png'], ref_video_name: 'x' },
    });
    expect(ok.status).toBe(200);
    expect(h.create.mock.calls[0][0].additionalOptions).toEqual({
      ref2v: true, ref_video_url: '/media/wan/v.mp4', ref_audio_url: '/media/b/a.wav', ref_image_urls: ['/media/b/1.png'], ref_video_name: 'x',
    });
  });
});
