import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  fetchSpy: vi.fn(),
  probe: vi.fn(),
}));

vi.mock('$lib/db', () => ({ getAdminSettings: async () => ({ roles: [] }) }));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => '/media/b/uploaded.png' }));
vi.mock('$lib/imageValidation', () => ({ validateAndConvertImage: async (b: Buffer) => ({ buffer: b, ext: 'png' }) }));
vi.mock('$lib/videoValidation', () => ({
  validateAndConvertVideo: async (b: Buffer) => ({ buffer: b, ext: 'webm', hasAudio: false }),
  extractVideoPoster: async () => null,
  probeVideoDuration: h.probe,
  hasAudioFromBuffer: async () => false,
  validateAndConvertReferenceAudio: async (b: Buffer) => ({ buffer: b, ext: 'wav' }),
}));
vi.mock('$lib/videoEntryCreation', () => ({ createVideoEntryForReview: h.create }));
vi.mock('$lib/serverImageUrl', () => ({ toOriginalUrl: (u: string) => u }));

import { createDraftFromUploadForm } from '../src/lib/uploadForm';

const user = { id: 'u1', roles: ['free'] };

beforeEach(() => {
  h.create.mockReset().mockResolvedValue({ success: true, entry: { id: 'd1' } });
  h.probe.mockReset();
  h.fetchSpy.mockReset().mockResolvedValue(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', h.fetchSpy);
});

describe('createDraftFromUploadForm', () => {
  it('apiMode refuses external ref_video_url and never fetches or probes it', async () => {
    for (const url of ['https://evil.example/v.mp4', 'http://169.254.169.254/x', '/media/../etc/passwd', 'file:///etc/passwd']) {
      const form = new FormData();
      form.set('mode', 'ref2v');
      form.set('ref_video_url', url);
      const r = await createDraftFromUploadForm(form, user, { apiMode: true });
      expect('error' in r, url).toBe(true);
    }
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('apiMode accepts an in-site /media path (and normalises an absolute url pointing at /media)', async () => {
    const form = new FormData();
    form.set('mode', 'ref2v');
    form.set('ref_video_url', 'https://animato.example/media/wan/out.mp4');
    const r = await createDraftFromUploadForm(form, user, { apiMode: true });
    expect('success' in r).toBe(true);
    expect(h.create.mock.calls[0][0].additionalOptions.ref_video_url).toBe('/media/wan/out.mp4');
    expect(h.create.mock.calls[0][0].userId).toBe('u1');
  });

  it('i2v: validates and creates a draft; missing file is an error', async () => {
    const ok = new FormData();
    ok.set('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
    const r = await createDraftFromUploadForm(ok, user, { apiMode: true });
    expect(r).toMatchObject({ success: true });
    expect(h.create.mock.calls[0][0]).toMatchObject({ mode: 'i2v', originalImageUrl: '/media/b/uploaded.png' });
    const missing = await createDraftFromUploadForm(new FormData(), user, { apiMode: true });
    expect(missing).toEqual({ error: 'no file' });
  });

  it('web form behaviour is unchanged: an external http(s) ref URL is still probed (default options)', async () => {
    h.probe.mockResolvedValue(100); // too long -> rejected by the duration cap
    const form = new FormData();
    form.set('mode', 'ref2v');
    form.set('ref_video_url', 'https://cdn.example/clip.mp4');
    const r = await createDraftFromUploadForm(form, user);
    expect(h.probe).toHaveBeenCalledWith('https://cdn.example/clip.mp4');
    expect('error' in r && r.error).toContain('max 6s');
  });
});
