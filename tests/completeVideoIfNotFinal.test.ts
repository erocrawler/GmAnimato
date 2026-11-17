import { beforeEach, describe, expect, it, vi } from 'vitest';

// JsonFileDatabase reads/writes data/videos.json; back fs/promises with an in-memory map so the
// real class runs without touching the disk (same pattern as queueSweeperJsonDb.test.ts).
const h = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock('fs/promises', () => {
  const api = {
    mkdir: async () => undefined,
    access: async (p: string) => {
      if (!h.files.has(p)) throw new Error('ENOENT');
    },
    readFile: async (p: string) => {
      if (!h.files.has(p)) throw new Error('ENOENT');
      return h.files.get(p)!;
    },
    writeFile: async (p: string, c: string) => {
      h.files.set(p, c);
    },
  };
  return { default: api, ...api };
});

import { JsonFileDatabase } from '../src/lib/db-json';

// The conditional write is what closes the webhook's read-then-blind-write race: the guard has
// to live in the write itself, so it is evaluated against the state at write time.
describe('completeVideoIfNotFinal: the guard lives in the write', () => {
  let db: JsonFileDatabase;
  const add = (over: any = {}) =>
    db.createVideoEntry({
      user_id: 'u1', original_image_url: 'x', status: 'processing', job_id: 'rp-1', ...over,
    } as any);

  beforeEach(() => {
    h.files.clear();
    db = new JsonFileDatabase();
  });

  it('writes the patch when the row is live and the job id matches', async () => {
    const v = await add();
    const ok = await db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/a.mp4' });
    expect(ok).toBe(true);
    const after = await db.getVideoById(v.id);
    expect(after).toMatchObject({ status: 'completed', final_video_url: '/media/a.mp4', job_id: 'rp-1' });
  });

  it('a progress update on a live row succeeds and keeps job_id', async () => {
    const v = await add({ status: 'in_queue' });
    const ok = await db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'processing', progress_percentage: 42 });
    expect(ok).toBe(true);
    expect(await db.getVideoById(v.id)).toMatchObject({ status: 'processing', progress_percentage: 42, job_id: 'rp-1' });
  });

  it('never overwrites a completed row (late failed / replay), and reports it', async () => {
    const v = await add({ status: 'completed', final_video_url: '/media/real.mp4' });
    expect(await db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'failed' })).toBe(false);
    expect(await db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/evil.mp4' })).toBe(false);
    expect(await db.getVideoById(v.id)).toMatchObject({ status: 'completed', final_video_url: '/media/real.mp4' });
  });

  it('never revives a deleted row', async () => {
    const v = await add({ status: 'deleted' });
    expect(await db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/x.mp4' })).toBe(false);
    expect((await db.getVideoById(v.id))!.status).toBe('deleted');
  });

  it('does not write when job_id no longer matches (retry superseded the job)', async () => {
    const v = await add({ job_id: 'rp-new' });
    expect(await db.completeVideoIfNotFinal(v.id, 'rp-old', { status: 'completed', final_video_url: '/media/x.mp4' })).toBe(false);
    const after = await db.getVideoById(v.id);
    expect(after).toMatchObject({ status: 'processing' });
    expect(after!.final_video_url).toBeUndefined();
  });

  it('does not write when the row does not exist', async () => {
    expect(await db.completeVideoIfNotFinal('nope', 'rp-1', { status: 'failed' })).toBe(false);
  });

  it('two concurrent terminal callbacks: only the first one lands', async () => {
    const v = await add();
    const results = await Promise.all([
      db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/first.mp4' }),
      db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'failed', final_video_url: '/media/second.mp4' }),
    ]);
    expect(results).toEqual([true, false]);
    expect(await db.getVideoById(v.id)).toMatchObject({ status: 'completed', final_video_url: '/media/first.mp4' });
  });

  it('two concurrent duplicates of the same completion: exactly one wins', async () => {
    const v = await add();
    const results = await Promise.all([
      db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/a.mp4' }),
      db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/b.mp4' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.getVideoById(v.id))!.final_video_url).toBe('/media/a.mp4');
  });

  it('a failed row is still writable (a genuine late completion after a sweep is kept)', async () => {
    const v = await add({ status: 'failed' });
    expect(await db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'completed', final_video_url: '/media/late.mp4' })).toBe(true);
    expect(await db.getVideoById(v.id)).toMatchObject({ status: 'completed', final_video_url: '/media/late.mp4' });
  });

  it('interleaves safely with updateVideo: no read-modify-write is lost', async () => {
    const v = await add({ status: 'in_queue' });
    const [ok] = await Promise.all([
      db.completeVideoIfNotFinal(v.id, 'rp-1', { status: 'processing', progress_percentage: 10 }),
      db.updateVideo(v.id, { dequeued_at: '2020-01-01T00:00:00.000Z' }),
      db.completeVideoIfNotFinal(v.id, 'rp-1', { progress_percentage: 20 }),
    ]);
    expect(ok).toBe(true);
    const after = await db.getVideoById(v.id);
    expect(after).toMatchObject({ status: 'processing', progress_percentage: 20, dequeued_at: '2020-01-01T00:00:00.000Z' });
  });
});
