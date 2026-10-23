import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStore } from './helpers/store';
import { hashApiToken, MAX_ACTIVE_TOKENS_PER_USER } from '../src/lib/apiTokens';

const h = vi.hoisted(() => ({ store: null as any }));
vi.mock('$lib/db', () => ({
  createApiToken: (i: any) => h.store.db.createApiToken(i),
  listApiTokensByUser: (u: string) => h.store.db.listApiTokensByUser(u),
  revokeApiToken: (id: string, u: string) => h.store.db.revokeApiToken(id, u),
}));

import { GET, POST } from '../src/routes/api/profile/tokens/+server';
import { DELETE } from '../src/routes/api/profile/tokens/[id]/+server';
import { GET as whoami } from '../src/routes/api/auth/session/+server';

const user = { id: 'u1', username: 'alice', email: 'alice@example.test', roles: ['free'], created_at: '2026-01-01' };
const jsonReq = (body: unknown) =>
  new Request('https://animato.test/api/profile/tokens', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('token management API (cookie session only)', () => {
  beforeEach(() => {
    h.store = makeStore();
    h.store.addUser('u1', 'alice');
  });

  it('creates a token: shown once, hash stored, expiry per request', async () => {
    const res = await POST({ request: jsonReq({ name: 'agent', expiresInDays: 7 }), locals: { user } } as any);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.token.startsWith('anim_pat_')).toBe(true);
    const stored = await h.store.db.getApiTokenByHash(hashApiToken(j.token));
    expect(stored).toBeTruthy();
    const days = (new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime()) / 86400_000;
    expect(Math.round(days)).toBe(7);
    // list never shows the secret or the hash
    const list = await (await GET({ locals: { user } } as any)).json();
    expect(JSON.stringify(list)).not.toContain(j.token);
    expect(JSON.stringify(list)).not.toContain(stored.token_hash);
    expect(list.tokens[0].display).toContain(j.prefix);
  });

  it('defaults to 30 days and rejects anything but 7/30/90', async () => {
    const ok = await (await POST({ request: jsonReq({ name: 'a' }), locals: { user } } as any)).json();
    const stored = await h.store.db.getApiTokenByHash(hashApiToken(ok.token));
    expect(Math.round((new Date(stored.expires_at).getTime() - Date.now()) / 86400_000)).toBe(30);
    for (const bad of [0, 14, 365, 'never', null, -1]) {
      const r = await POST({ request: jsonReq({ name: 'x', expiresInDays: bad }), locals: { user } } as any);
      // null falls back to the default (absent), everything else is refused
      if (bad === null) expect(r.status).toBe(201);
      else {
        expect(r.status).toBe(400);
        expect((await r.json()).errorCode).toBe('invalid_expiry');
      }
    }
  });

  it('validates the name', async () => {
    expect((await POST({ request: jsonReq({ name: '' }), locals: { user } } as any)).status).toBe(400);
    expect((await POST({ request: jsonReq({ name: 'x'.repeat(51) }), locals: { user } } as any)).status).toBe(400);
  });

  it('allows at most 5 active tokens per user; revoked and expired ones do not count', async () => {
    for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_USER; i++) {
      expect((await POST({ request: jsonReq({ name: `t${i}` }), locals: { user } } as any)).status).toBe(201);
    }
    const over = await POST({ request: jsonReq({ name: 'one-too-many' }), locals: { user } } as any);
    expect(over.status).toBe(409);
    expect((await over.json()).errorCode).toBe('token_limit');

    // another user is independent
    h.store.addUser('u2', 'bob');
    expect((await POST({ request: jsonReq({ name: 'b' }), locals: { user: { ...user, id: 'u2' } } } as any)).status).toBe(201);

    // revoke one -> room again
    const first = (await h.store.db.listApiTokensByUser('u1'))[0];
    expect((await DELETE({ params: { id: first.id }, locals: { user } } as any)).status).toBe(200);
    expect((await POST({ request: jsonReq({ name: 'again' }), locals: { user } } as any)).status).toBe(201);

  });

  it('expired tokens do not count towards the cap', async () => {
    h.store.addUser('u3', 'carol');
    const u3 = { ...user, id: 'u3' };
    await h.store.issueToken('u3', { expiresAt: new Date(Date.now() - 1000) });
    for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_USER; i++) {
      expect((await POST({ request: jsonReq({ name: `t${i}` }), locals: { user: u3 } } as any)).status).toBe(201);
    }
    expect((await POST({ request: jsonReq({ name: 'over' }), locals: { user: u3 } } as any)).status).toBe(409);
  });

  it("DELETE only revokes the caller's own token (404 otherwise)", async () => {
    const { record } = await h.store.issueToken('u1');
    h.store.addUser('u2', 'bob');
    const other = await DELETE({ params: { id: record.id }, locals: { user: { ...user, id: 'u2' } } } as any);
    expect(other.status).toBe(404);
    expect((await DELETE({ params: { id: record.id }, locals: { user } } as any)).status).toBe(200);
    expect((await DELETE({ params: { id: record.id }, locals: { user } } as any)).status).toBe(404);
  });

  it('requires a login and refuses callers authenticated by a PAT', async () => {
    expect((await GET({ locals: {} } as any)).status).toBe(401);
    expect((await POST({ request: jsonReq({ name: 'x' }), locals: {} } as any)).status).toBe(401);
    const tokenLocals = { user, token: { id: 't', name: 'n', prefix: 'p', expires_at: 'x' } };
    expect((await GET({ locals: tokenLocals } as any)).status).toBe(403);
    expect((await POST({ request: jsonReq({ name: 'x' }), locals: tokenLocals } as any)).status).toBe(403);
    expect((await DELETE({ params: { id: 'a' }, locals: tokenLocals } as any)).status).toBe(403);
  });
});

describe('GET /api/auth/session (whoami)', () => {
  it('returns the full user for cookie sessions', async () => {
    const j = await (await whoami({ locals: { user } } as any)).json();
    expect(j.user.email).toBe('alice@example.test');
  });

  it('strips email for token callers and reports the token expiry', async () => {
    const j = await (
      await whoami({ locals: { user, token: { id: 't', name: 'agent', prefix: 'abcd1234', expires_at: '2099-01-01T00:00:00Z' } } } as any)
    ).json();
    expect(j.user.username).toBe('alice');
    expect(j.user.roles).toEqual(['free']);
    expect(JSON.stringify(j)).not.toContain('example.test');
    expect(j.user.email).toBeUndefined();
    expect(j.token.expires_at).toBe('2099-01-01T00:00:00Z');
  });

  it('401 JSON when anonymous', async () => {
    const r = await whoami({ locals: {} } as any);
    expect(r.status).toBe(401);
  });
});
