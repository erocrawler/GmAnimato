import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ jwtEnabled: true, jwtCalls: [] as any[] }));
vi.mock('$lib/db', () => ({
  updateUser: async (id: string, patch: any) => ({
    id, username: 'alice', email: patch.email, roles: ['free'], created_at: 'c', updated_at: 'u', password_hash: 'secret',
  }),
}));
vi.mock('$lib/session', () => ({
  get JWT_ENABLED() { return h.jwtEnabled; },
  generateJWT: (p: any) => { h.jwtCalls.push(p); return 'new.jwt'; },
  SESSION_COOKIE_OPTIONS: { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 604800 },
}));

import { PUT } from '../src/routes/api/profile/update/+server';

function run() {
  const sets: any[] = [];
  const request = new Request('https://animato.test/api/profile/update', {
    method: 'PUT', body: JSON.stringify({ email: 'new@example.test' }), headers: { 'content-type': 'application/json' },
  });
  const cookies = { set: (...a: any[]) => sets.push(a), get: () => undefined, delete: () => {} };
  const locals = { user: { id: 'u1', username: 'alice', roles: ['free'] } };
  return (PUT as any)({ request, locals, cookies }).then((res: Response) => ({ res, sets }));
}

describe('profile update vs session cookie', () => {
  beforeEach(() => { h.jwtCalls.length = 0; });

  it('JWT mode: re-issues a signed JWT with the new email using SESSION_COOKIE_OPTIONS (not user JSON)', async () => {
    h.jwtEnabled = true;
    const { res, sets } = await run();
    expect(res.status).toBe(200);
    expect(h.jwtCalls).toEqual([{ id: 'u1', username: 'alice', email: 'new@example.test', roles: ['free'] }]);
    expect(sets).toHaveLength(1);
    expect(sets[0][0]).toBe('session');
    expect(sets[0][1]).toBe('new.jwt');
    expect(sets[0][2]).toMatchObject({ secure: true, httpOnly: true, maxAge: 604800 });
    const body = await res.json();
    expect(body.user.email).toBe('new@example.test');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('opaque-token mode: does not touch the session cookie', async () => {
    h.jwtEnabled = false;
    const { res, sets } = await run();
    expect(res.status).toBe(200);
    expect(sets).toEqual([]);
    expect(h.jwtCalls).toEqual([]);
    expect((await res.json()).user.email).toBe('new@example.test');
  });
});
