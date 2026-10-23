import { describe, expect, it } from 'vitest';
import { authenticatePat, gatePatRequest, wantsJsonUnauthorized } from '../src/lib/patAuth';
import { TokenRateLimiter } from '../src/lib/rateLimit';
import { makeStore } from './helpers/store';

async function body(res: Response) {
  return res.json();
}

describe('authenticatePat', () => {
  it('accepts a live token and returns the user', async () => {
    const s = makeStore();
    s.addUser('u1', 'alice');
    const { raw, record } = await s.issueToken('u1');
    const r = await authenticatePat(raw, s.deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.username).toBe('alice');
      expect(r.token.id).toBe(record.id);
    }
  });

  it('rejects unknown tokens with 401 invalid_token', async () => {
    const s = makeStore();
    const r = await authenticatePat('anim_pat_nope', s.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect((await body(r.response)).errorCode).toBe('invalid_token');
    }
  });

  it('rejects expired tokens immediately at the boundary', async () => {
    const s = makeStore();
    s.addUser('u1');
    const { raw, record } = await s.issueToken('u1', { days: 7 });
    const expiry = new Date(record.expires_at);
    const justBefore = await authenticatePat(raw, s.deps, new Date(expiry.getTime() - 1));
    expect(justBefore.ok).toBe(true);
    const atExpiry = await authenticatePat(raw, s.deps, expiry);
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) {
      expect(atExpiry.response.status).toBe(401);
      expect((await body(atExpiry.response)).errorCode).toBe('token_expired');
    }
  });

  it('rejects revoked tokens immediately', async () => {
    const s = makeStore();
    s.addUser('u1');
    const { raw, record } = await s.issueToken('u1');
    expect((await authenticatePat(raw, s.deps)).ok).toBe(true);
    expect(await s.db.revokeApiToken(record.id, 'u1')).toBe(true);
    const r = await authenticatePat(raw, s.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await body(r.response)).errorCode).toBe('token_revoked');
  });

  it("cannot revoke someone else's token", async () => {
    const s = makeStore();
    s.addUser('u1');
    s.addUser('u2');
    const { raw, record } = await s.issueToken('u1');
    expect(await s.db.revokeApiToken(record.id, 'u2')).toBe(false);
    expect((await authenticatePat(raw, s.deps)).ok).toBe(true);
  });

  it('rejects tokens whose user was deleted', async () => {
    const s = makeStore();
    s.addUser('u1');
    const { raw } = await s.issueToken('u1');
    s.users.delete('u1');
    const r = await authenticatePat(raw, s.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('updates last_used_at, but at most once per minute', async () => {
    const s = makeStore();
    s.addUser('u1');
    const { raw, record } = await s.issueToken('u1');
    const t0 = new Date();
    await authenticatePat(raw, s.deps, t0);
    const first = (await s.db.getApiTokenByHash(record.token_hash))!.last_used_at;
    expect(first).toBe(t0.toISOString());
    await authenticatePat(raw, s.deps, new Date(t0.getTime() + 10_000));
    expect((await s.db.getApiTokenByHash(record.token_hash))!.last_used_at).toBe(first);
    const t2 = new Date(t0.getTime() + 61_000);
    await authenticatePat(raw, s.deps, t2);
    expect((await s.db.getApiTokenByHash(record.token_hash))!.last_used_at).toBe(t2.toISOString());
  });

  it('the stored record never contains the plaintext token', async () => {
    const s = makeStore();
    s.addUser('u1');
    const { raw, record } = await s.issueToken('u1');
    expect(JSON.stringify(record)).not.toContain(raw);
    expect(JSON.stringify(await s.db.listApiTokensByUser('u1'))).not.toContain(raw);
  });
});

describe('gatePatRequest', () => {
  const mk = async () => {
    const s = makeStore();
    s.addUser('u1', 'alice');
    const { raw } = await s.issueToken('u1');
    const limiter = new TokenRateLimiter();
    const call = (method: string, pathname: string, authorization: string | null = `Bearer ${raw}`) =>
      gatePatRequest({ authorization, method, pathname }, s.deps, limiter);
    return { s, raw, call };
  };

  it('ignores non-PAT credentials (falls through to the JWT/cookie flow)', async () => {
    const { call } = await mk();
    expect((await call('GET', '/api/quota', 'Bearer eyJhbGciOiJSUzI1NiJ9.x.y')).kind).toBe('not-pat');
    expect((await call('GET', '/api/quota', null)).kind).toBe('not-pat');
    expect((await call('GET', '/api/quota', 'Basic Zm9v')).kind).toBe('not-pat');
  });

  it('passes allowlisted requests', async () => {
    const { call } = await mk();
    const r = await call('GET', '/api/quota');
    expect(r.kind).toBe('ok');
  });

  it.each([
    ['PUT', '/api/profile/update'],
    ['POST', '/api/profile/change-password'],
    ['POST', '/api/profile/tokens'],
    ['DELETE', '/api/profile/tokens/abc'],
    ['POST', '/api/auth'],
    ['POST', '/api/logout'],
    ['GET', '/api/admin/settings'],
    ['GET', '/admin'],
    ['POST', '/api/video/abc/like'],
    ['GET', '/api/gallery/short'],
    ['DELETE', '/api/video/abc'],
  ])('403 token_scope for %s %s', async (method, path) => {
    const { call } = await mk();
    const r = await call(method, path);
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.response.status).toBe(403);
      const j = await body(r.response);
      expect(j.errorCode).toBe('token_scope');
      expect(Array.isArray(j.allowed)).toBe(true);
    }
  });

  it('refuses SvelteKit data requests even on an allowed path', async () => {
    const s = makeStore();
    s.addUser('u1');
    const { raw } = await s.issueToken('u1');
    const r = await gatePatRequest(
      { authorization: `Bearer ${raw}`, method: 'GET', pathname: '/api/quota', isDataRequest: true },
      s.deps,
      new TokenRateLimiter()
    );
    expect(r.kind).toBe('reject');
  });

  it('auth failure wins over scope failure (invalid token on a forbidden path is 401)', async () => {
    const { call } = await mk();
    const r = await call('GET', '/api/admin/settings', 'Bearer anim_pat_bogus');
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.response.status).toBe(401);
  });

  it('429 with Retry-After after 60 requests/min, and after 10 heavy ones', async () => {
    const { call } = await mk();
    for (let i = 0; i < 60; i++) expect((await call('GET', '/api/quota')).kind).toBe('ok');
    const over = await call('GET', '/api/quota');
    expect(over.kind).toBe('reject');
    if (over.kind === 'reject') {
      expect(over.response.status).toBe(429);
      expect(Number(over.response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      expect((await body(over.response)).errorCode).toBe('rate_limited');
    }

    const h = await mk();
    for (let i = 0; i < 10; i++) expect((await h.call('POST', '/api/i2v/kickoff')).kind).toBe('ok');
    const heavyOver = await h.call('POST', '/api/uploads'); // uploads share the heavy bucket
    expect(heavyOver.kind).toBe('reject');
    if (heavyOver.kind === 'reject') expect(heavyOver.response.status).toBe(429);
  });
});

describe('wantsJsonUnauthorized', () => {
  it('answers programmatic /api clients with 401 JSON, leaves browsers alone', () => {
    expect(wantsJsonUnauthorized('/api/quota', new Headers({ authorization: 'Bearer x' }))).toBe(true);
    expect(wantsJsonUnauthorized('/api/quota', new Headers({ accept: 'application/json' }))).toBe(true);
    expect(wantsJsonUnauthorized('/api/quota', new Headers({ accept: 'text/html,application/xhtml+xml' }))).toBe(false);
    expect(wantsJsonUnauthorized('/api/quota', new Headers())).toBe(false);
    expect(wantsJsonUnauthorized('/videos', new Headers({ accept: 'application/json' }))).toBe(false);
    expect(wantsJsonUnauthorized('/media/x', new Headers({ authorization: 'Bearer x' }))).toBe(false);
  });
});
