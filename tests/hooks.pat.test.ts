import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStore } from './helpers/store';
import { hashApiToken } from '../src/lib/apiTokens';

// The hook is exercised end to end against an in-memory store: no real DB.
const h = vi.hoisted(() => ({ store: null as any }));

vi.mock('$lib/db', () => ({
  getSessionByToken: async () => undefined,
  getUserById: async (id: string) => h.store.users.get(id),
  deleteSession: async () => true,
  deleteExpiredSessions: async () => 0,
  getAllSponsorClaims: async () => [],
  deleteSponsorClaim: async () => false,
  expireSponsorClaim: async () => false,
  updateSponsorClaim: async () => null,
  updateUser: async () => null,
  getAdminSettings: async () => ({}),
  getApiTokenByHash: (x: string) => h.store.deps.getApiTokenByHash(x),
  touchApiToken: (id: string, at: Date) => h.store.deps.touchApiToken(id, at),
}));
vi.mock('$app/environment', () => ({ building: true, dev: false, browser: false, version: 'test' }));
vi.mock('$lib/session', () => ({
  isSessionExpired: () => true,
  verifyJWT: (t: string) => (t === 'valid.jwt' ? { id: 'u1', username: 'alice', roles: ['free'] } : null),
  JWT_ENABLED: true,
  generateJWT: () => null,
  SESSION_COOKIE_OPTIONS: {},
}));

import { handle } from '../src/hooks.server';

function makeEvent(url: string, init: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  const request = new Request(url, { method: init.method ?? 'GET', headers: init.headers });
  const jar = init.cookies ?? {};
  return {
    request,
    url: new URL(url),
    isDataRequest: false,
    locals: {} as any,
    cookies: { get: (n: string) => jar[n], set: () => {}, delete: () => {} },
  } as any;
}

// resolve() stand-in that records what the route would have seen
function runHandle(event: any) {
  let seen: any = null;
  const resolve = async (e: any) => {
    seen = { user: e.locals.user, token: e.locals.token };
    return new Response('ok', { status: 200 });
  };
  const p = (handle as any)({ event, resolve });
  return p.then(
    (res: Response) => ({ res, seen }),
    (err: any) => ({ res: null as any, seen, thrown: err })
  );
}

const BASE = 'https://animato.test';

describe('hooks: personal access tokens', () => {
  let s: ReturnType<typeof makeStore>;
  let raw: string;

  beforeEach(async () => {
    s = makeStore();
    h.store = s;
    s.addUser('u1', 'alice', ['free']);
    raw = (await s.issueToken('u1')).raw;
  });

  it('authenticates an allowlisted request and sets locals.user + locals.token', async () => {
    const { res, seen } = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: `Bearer ${raw}` } }));
    expect(res.status).toBe(200);
    expect(seen.user.username).toBe('alice');
    expect(seen.user.roles).toEqual(['free']);
    expect(seen.token.prefix).toHaveLength(8);
  });

  it('401 JSON for an invalid / expired / revoked token', async () => {
    const bad = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: 'Bearer anim_pat_wrong' } }));
    expect(bad.res.status).toBe(401);
    expect((await bad.res.json()).errorCode).toBe('invalid_token');

    const expired = (await s.issueToken('u1', { expiresAt: new Date(Date.now() - 1000) })).raw;
    const e = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: `Bearer ${expired}` } }));
    expect(e.res.status).toBe(401);
    expect((await e.res.json()).errorCode).toBe('token_expired');

    const rec = (await s.db.getApiTokenByHash(hashApiToken(raw)))!;
    await s.db.revokeApiToken(rec.id, 'u1');
    const r = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: `Bearer ${raw}` } }));
    expect(r.res.status).toBe(401);
  });

  it('403 outside the allowlist, without reaching the route', async () => {
    for (const [method, path] of [['PUT', '/api/profile/update'], ['POST', '/api/profile/tokens'], ['GET', '/api/admin/settings'], ['POST', '/api/logout']]) {
      const { res, seen } = await runHandle(makeEvent(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' } }));
      expect(res.status).toBe(403);
      expect(seen).toBeNull();
    }
  });

  it('a PAT ignores cookies: a valid session cookie does not widen its scope', async () => {
    const { res } = await runHandle(
      makeEvent(`${BASE}/api/profile/update`, { method: 'PUT', headers: { authorization: `Bearer ${raw}` }, cookies: { session: 'valid.jwt' } })
    );
    expect(res.status).toBe(403);
  });

  it('multipart uploads with a PAT pass without an Origin header (CSRF check skipped)', async () => {
    const { res, seen } = await runHandle(
      makeEvent(`${BASE}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${raw}`, 'content-type': 'multipart/form-data; boundary=x' } })
    );
    expect(res.status).toBe(200);
    expect(seen.token).toBeTruthy();
  });

  it('the same multipart POST without a PAT is still rejected by the form-origin check', async () => {
    const { res } = await runHandle(
      makeEvent(`${BASE}/api/uploads`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, cookies: { session: 'valid.jwt' } })
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Cross-site POST form submissions are forbidden');
  });

  it('cookie sessions with a same-origin form post are unaffected', async () => {
    const { res, seen } = await runHandle(
      makeEvent(`${BASE}/api/uploads`, { method: 'POST', headers: { origin: BASE, 'content-type': 'multipart/form-data; boundary=x' }, cookies: { session: 'valid.jwt' } })
    );
    expect(res.status).toBe(200);
    expect(seen.user.id).toBe('u1');
    expect(seen.token).toBeUndefined();
  });

  it('a non-PAT Bearer JWT still takes the original flow', async () => {
    const { res, seen } = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: 'Bearer valid.jwt' } }));
    expect(res.status).toBe(200);
    expect(seen.user.username).toBe('alice');
    expect(seen.token).toBeUndefined();
  });

  it('unauthenticated /api requests: 401 JSON for API clients, 303 for browsers', async () => {
    const withAccept = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { accept: 'application/json' } }));
    expect(withAccept.res.status).toBe(401);
    expect((await withAccept.res.json()).errorCode).toBe('unauthenticated');

    const badJwt = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: 'Bearer not-a-valid-jwt' } }));
    expect(badJwt.res.status).toBe(401);

    const browser = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { accept: 'text/html' } }));
    expect(browser.thrown?.status).toBe(303);
    expect(browser.thrown?.location).toBe('/login');

    const page = await runHandle(makeEvent(`${BASE}/videos`, { headers: { accept: 'application/json' } }));
    expect(page.thrown?.status).toBe(303); // pages keep redirecting
  });

  it('429 after the per-token request budget', async () => {
    let last = 200;
    for (let i = 0; i < 61; i++) {
      const { res } = await runHandle(makeEvent(`${BASE}/api/quota`, { headers: { authorization: `Bearer ${raw}` } }));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
