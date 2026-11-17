import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FfmpegTimeoutError } from '../src/lib/server/ffmpegRun';

const h = vi.hoisted(() => ({
  runs: [] as Array<{ resolve: () => void; reject: (e: Error) => void; args: string[] }>,
  mode: 'hang' as 'hang' | 'timeout',
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/db', () => ({
  getVideoById: async (id: string) => ({
    id,
    user_id: 'u1',
    is_published: true,
    status: 'completed',
    final_video_url: 'https://example.invalid/v.mp4',
  }),
}));
vi.mock('../src/lib/server/ffmpegRun', async (orig) => {
  const real = await orig<typeof import('../src/lib/server/ffmpegRun')>();
  return {
    ...real,
    runFfmpeg: (args: string[]) => {
      if (h.mode === 'timeout') return Promise.reject(new real.FfmpegTimeoutError(120000));
      return new Promise<void>((resolve, reject) => h.runs.push({ resolve, reject, args }));
    },
  };
});

import { GET } from '../src/routes/api/video/[id]/download/+server';

const call = (id: string, qs: string) =>
  GET({
    params: { id },
    locals: {},
    url: new URL(`http://x/api/video/${id}/download?${qs}`),
  } as any) as Promise<Response>;

beforeEach(() => {
  h.runs.length = 0;
  h.mode = 'hang';
});

describe('GET /api/video/[id]/download', () => {
  it('400 for fps/scale outside the preset whitelist', async () => {
    expect((await call('a', 'format=gif&fps=30')).status).toBe(400);
    expect((await call('a', 'format=gif&scale=1280')).status).toBe(400);
    expect((await call('a', 'format=webp&fps=abc')).status).toBe(400);
    expect(h.runs.length).toBe(0);
  });

  it('504 when ffmpeg times out', async () => {
    h.mode = 'timeout';
    const res = await call('t1', 'format=gif');
    expect(res.status).toBe(504);
    expect(new FfmpegTimeoutError(1)).toBeInstanceOf(Error);
  });

  it('caps concurrency at 2, queues 20, then answers 429 + Retry-After', async () => {
    const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 22; i++) pending.push(call(`q${i}`, 'format=webp'));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runs.length).toBe(2); // only 2 ffmpeg started, 20 queued

    const res = await call('q-overflow', 'format=webp');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);

    // same key as a queued one is deduplicated, not counted against the queue
    const dup = call('q5', 'format=webp');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runs.length).toBe(2);

    // drain: fail every run so the queue empties and nothing leaks into other tests
    for (let guard = 0; guard < 100 && h.runs.length; guard++) {
      h.runs.shift()!.reject(new Error('stop'));
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = await Promise.all([...pending, dup]);
    expect(all.every((r) => r.status === 500)).toBe(true);
  });
});
