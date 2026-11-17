import { beforeEach, describe, expect, it, vi } from 'vitest';

// DELETE /api/video/[id] against an in-memory video: no DB.
const h = vi.hoisted(() => ({ video: null as any, deleted: [] as string[] }));

vi.mock('$lib/db', () => ({
  getVideoById: async (id: string) => (h.video && h.video.id === id ? { ...h.video } : undefined),
  deleteVideo: async (id: string) => { h.deleted.push(id); return true; },
  getUserById: async () => undefined,
}));

import { DELETE } from '../src/routes/api/video/[id]/+server';

const owner = { id: 'u1', username: 'alice', roles: ['free'] };
const other = { id: 'u2', username: 'bob', roles: ['free'] };

function del(user: any) {
  return DELETE({ params: { id: 'v1' }, locals: { user }, request: new Request('http://x/api/video/v1', { method: 'DELETE' }) } as any);
}

describe('DELETE /api/video/[id]', () => {
  beforeEach(() => { h.deleted = []; h.video = { id: 'v1', user_id: 'u1', status: 'completed' }; });

  it.each(['completed', 'failed', 'uploaded'])('lets the owner delete a %s video', async (status) => {
    h.video.status = status;
    const res = await del(owner);
    expect(res.status).toBe(200);
    expect(h.deleted).toEqual(['v1']);
  });

  it.each(['processing', 'in_queue'])('refuses to delete a %s video (400), the row stays', async (status) => {
    h.video.status = status;
    const res = await del(owner);
    expect(res.status).toBe(400);
    expect(h.deleted).toEqual([]);
  });

  it('refuses another user', async () => {
    const res = await del(other);
    expect(res.status).toBe(403);
    expect(h.deleted).toEqual([]);
  });
});
