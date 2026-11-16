import { beforeEach, describe, expect, it, vi } from 'vitest';

// JsonFileDatabase reads/writes data/videos.json; back fs/promises with an in-memory map so the
// real class runs without touching the disk.
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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const iso = (m: number) => ago(m).toISOString();

describe('JsonFileDatabase: queue sweeper methods (same contract as Postgres)', () => {
  let db: JsonFileDatabase;
  const add = (over: any = {}) =>
    db.createVideoEntry({
      user_id: 'u1', original_image_url: 'x', status: 'in_queue', is_local_job: true, job_id: 'local-x',
      ...over,
    } as any);

  beforeEach(() => {
    h.files.clear();
    db = new JsonFileDatabase();
  });

  describe('failTimedOutProcessing', () => {
    it('only fails processing rows with an expired dequeued_at; keeps job_id', async () => {
      const e1 = await add({ status: 'processing', job_id: 'rp-1', is_local_job: false, dequeued_at: iso(31) });
      const e2 = await add({ status: 'processing', job_id: 'local-2', dequeued_at: iso(600) });
      const others = [
        await add({ status: 'processing', dequeued_at: iso(5) }),
        await add({ status: 'processing' }), // no dequeued_at
        await add({ status: 'in_queue', dequeued_at: iso(600) }),
        await add({ status: 'completed', dequeued_at: iso(600) }),
        await add({ status: 'failed', dequeued_at: iso(600) }),
        await add({ status: 'uploaded', dequeued_at: iso(600) }),
      ];
      const ids = await db.failTimedOutProcessing(ago(30));
      expect(ids.sort()).toEqual([e1.id, e2.id].sort());
      const all = (await db.getAllVideos({ pageSize: 100 })).videos;
      const by = (id: string) => all.find((v) => v.id === id)!;
      expect(by(e1.id)).toMatchObject({ status: 'failed', job_id: 'rp-1' });
      expect(by(e2.id)).toMatchObject({ status: 'failed', job_id: 'local-2' });
      for (const o of others) expect(by(o.id).status).toBe(o.status);
      expect(await db.failTimedOutProcessing(ago(30))).toEqual([]);
    });

    it('does not touch a row that already became completed', async () => {
      const v = await add({ status: 'processing', dequeued_at: iso(120) });
      await db.updateVideo(v.id, { status: 'completed' });
      expect(await db.failTimedOutProcessing(ago(30))).toEqual([]);
      expect((await db.getVideoById(v.id))!.status).toBe('completed');
    });
  });

  describe('claimStaleLocalJob', () => {
    it('claims only stale local in_queue rows, oldest first, reserving as processing + dequeued_at', async () => {
      const stale = await add({ processing_started_at: iso(45) });
      const staler = await add({ processing_started_at: iso(90) });
      const young = await add({ processing_started_at: iso(10) });
      const rp = await add({ is_local_job: false, processing_started_at: iso(500) });
      const proc = await add({ status: 'processing', processing_started_at: iso(500), dequeued_at: iso(1) });
      const done = await add({ status: 'completed', processing_started_at: iso(500) });

      const first = await db.claimStaleLocalJob(ago(30));
      expect(first!.id).toBe(staler.id);
      expect(first!.status).toBe('processing');
      expect(new Date(first!.dequeued_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect((await db.claimStaleLocalJob(ago(30)))!.id).toBe(stale.id);
      expect(await db.claimStaleLocalJob(ago(30))).toBeNull();
      for (const [v, status] of [[young, 'in_queue'], [rp, 'in_queue'], [proc, 'processing'], [done, 'completed']] as const) {
        expect((await db.getVideoById(v.id))!.status).toBe(status);
      }
    });

    it('falls back to created_at when processing_started_at is missing; excludeIds skips rows', async () => {
      const young = await add({}); // created just now, no processing_started_at
      expect(await db.claimStaleLocalJob(ago(30))).toBeNull();
      expect((await db.getVideoById(young.id))!.status).toBe('in_queue');

      const a = await add({ processing_started_at: iso(90) });
      const b = await add({ processing_started_at: iso(80) });
      expect((await db.claimStaleLocalJob(ago(30), [a.id]))!.id).toBe(b.id);
    });

    it('concurrent claims never hand out the same row (in-process serialisation)', async () => {
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(await add({ id: `c${i}`, processing_started_at: iso(60) })); // sequential: the JSON store has no write locking
      const claims = await Promise.all(Array.from({ length: 8 }, () => db.claimStaleLocalJob(ago(30))));
      const got = claims.filter(Boolean).map((c) => c!.id);
      expect(got).toHaveLength(4);
      expect(new Set(got).size).toBe(4);
      expect(new Set(got)).toEqual(new Set(rows.map((r) => r.id)));
    });
  });
});
