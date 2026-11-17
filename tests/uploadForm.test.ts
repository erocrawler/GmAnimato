import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  fetchSpy: vi.fn(),
  probe: vi.fn(),
  validateVideo: vi.fn(),
}));

vi.mock('$lib/db', () => ({ getAdminSettings: async () => ({ roles: [] }) }));
vi.mock('$lib/s3', () => ({ uploadBufferToS3: async () => '/media/b/uploaded.png' }));
vi.mock('$lib/imageValidation', () => ({ validateAndConvertImage: async (b: Buffer) => ({ buffer: b, ext: 'png' }) }));
vi.mock('$lib/videoValidation', () => ({
  validateAndConvertVideo: async (b: Buffer, ...rest: unknown[]) => { h.validateVideo(b, ...rest); return { buffer: b, ext: 'webm', hasAudio: false, durationSec: 5.5 }; },
  extractVideoPoster: async () => null,
  probeVideoDuration: h.probe,
  probeVideoDurationFromBuffer: async () => 7.25,
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
  h.validateVideo.mockReset();
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

  it('web form refuses external ref_video_url too: no fetch, no probe, no draft', async () => {
    for (const url of ['https://cdn.example/clip.mp4', 'http://127.0.0.1:3999/x', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', '//evil.example/x', '/media/../etc/passwd', '/uploads/x.mp4']) {
      const form = new FormData();
      form.set('mode', 'ref2v');
      form.set('ref_video_url', url);
      const r = await createDraftFromUploadForm(form, user);
      expect('error' in r && r.error, url).toBe('ref_video_url must be a /media/... path (upload the file instead)');
    }
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.validateVideo).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('web form still accepts an in-site /media path (and an absolute url pointing at /media), probing it via the S3 object', async () => {
    h.fetchSpy.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    for (const input of ['/media/wan/out.mp4', 'https://animato.example/media/wan/out.mp4']) {
      h.create.mockClear();
      const form = new FormData();
      form.set('mode', 'ref2v');
      form.set('ref_video_url', input);
      const r = await createDraftFromUploadForm(form, user);
      expect('success' in r, input).toBe(true);
      const opts = h.create.mock.calls[0][0].additionalOptions;
      expect(opts.ref_video_url).toBe('/media/wan/out.mp4');
      expect(opts.ref_video_duration).toBe(7.25);
    }
    // fetched only to inspect our own object; never the external host from the absolute form
    for (const call of h.fetchSpy.mock.calls) expect(String(call[0])).not.toContain('animato.example');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.validateVideo).not.toHaveBeenCalled();
  });

  it('server fills ref_video_duration when the client sends none (file upload)', async () => {
    const form = new FormData();
    form.set('mode', 'ref2v');
    form.set('ref_video', new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), 'clip.mp4');
    const r = await createDraftFromUploadForm(form, user, { apiMode: true });
    expect('success' in r).toBe(true);
    expect(h.create.mock.calls[0][0].additionalOptions.ref_video_duration).toBe(5.5);
  });

  it('client duration wins over the server probe', async () => {
    const form = new FormData();
    form.set('mode', 'ref2v');
    form.set('ref_video', new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), 'clip.mp4');
    form.set('ref_video_duration', '4.2');
    const r = await createDraftFromUploadForm(form, user, { apiMode: true });
    expect('success' in r).toBe(true);
    expect(h.create.mock.calls[0][0].additionalOptions.ref_video_duration).toBe(4.2);
  });
});
