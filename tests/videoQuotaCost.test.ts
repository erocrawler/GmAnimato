import { describe, expect, it, vi } from 'vitest';
import { PostgresDatabase } from '../src/lib/db-postgres';

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'v1', userId: 'u1', workflowId: 'w1', originalImageUrl: 'https://x/a.png', status: 'in_queue',
  createdAt: new Date('2026-11-01T00:00:00Z'), quotaCost: 1, ...extra,
});

// The kickoff snapshots the credit cost into the video row; the Postgres layer used to drop it, so the
// column stayed at its default 1 and the daily usage sum counted every video as one credit.
describe('video quota_cost persistence (Postgres layer)', () => {
  function dbWith(video: Record<string, any>) {
    const db = new PostgresDatabase('postgresql://u:p@127.0.0.1:1/none');
    (db as any).prisma = { video };
    return db;
  }

  it('updateVideo writes quota_cost and does not touch it when absent', async () => {
    const update = vi.fn(async ({ data }: any) => row(data));
    const db = dbWith({ update });
    const out = await db.updateVideo('v1', { quota_cost: 3, status: 'in_queue' });
    expect(update.mock.calls[0][0].data.quotaCost).toBe(3);
    expect(out?.quota_cost).toBe(3);
    await db.updateVideo('v1', { status: 'completed' });
    expect(update.mock.calls[1][0].data).not.toHaveProperty('quotaCost');
  });

  it('createVideoEntry passes quota_cost through (undefined keeps the column default)', async () => {
    const create = vi.fn(async ({ data }: any) => row(data));
    const db = dbWith({ create });
    const base = { id: 'v1', user_id: 'u1', original_image_url: 'https://x/a.png', status: 'uploaded', created_at: '' } as any;
    await db.createVideoEntry({ ...base, quota_cost: 2 });
    expect(create.mock.calls[0][0].data.quotaCost).toBe(2);
    await db.createVideoEntry(base);
    expect(create.mock.calls[1][0].data.quotaCost).toBeUndefined();
  });
});
