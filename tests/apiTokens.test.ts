import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EXPIRY_DAYS,
  computeExpiry,
  countActiveTokens,
  DEFAULT_EXPIRY_DAYS,
  generateApiToken,
  getTokenState,
  hashApiToken,
  isApiTokenString,
  isHeavyTokenRoute,
  isRouteAllowedForToken,
  parseBearer,
  parseExpiresInDays,
  TOKEN_ALLOWED_ENDPOINTS,
  TOKEN_PREFIX,
  toPublicToken,
  validateTokenName,
} from '../src/lib/apiTokens';

describe('token generation and hashing', () => {
  it('has the anim_pat_ prefix, >=32 random chars and a display prefix of 8', () => {
    const g = generateApiToken();
    expect(g.token.startsWith('anim_pat_')).toBe(true);
    const random = g.token.slice(TOKEN_PREFIX.length);
    expect(random.length).toBeGreaterThanOrEqual(32);
    expect(random).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(g.prefix).toBe(random.slice(0, 8));
    expect(g.prefix).toHaveLength(8);
  });

  it('hashes with SHA-256 (hex, 64 chars), deterministically, and never stores the secret', () => {
    const g = generateApiToken();
    expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiToken(g.token)).toBe(g.hash);
    expect(g.hash).not.toContain(g.token);
    // known vector: sha256("abc")
    expect(hashApiToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('produces unique tokens', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateApiToken().token));
    expect(set.size).toBe(200);
  });

  it('recognises PAT strings and parses Bearer headers', () => {
    expect(isApiTokenString('anim_pat_abc')).toBe(true);
    expect(isApiTokenString('eyJhbGciOi...')).toBe(false);
    expect(isApiTokenString(null)).toBe(false);
    expect(parseBearer('Bearer anim_pat_x')).toBe('anim_pat_x');
    expect(parseBearer('bearer   tok')).toBe('tok');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe('expiry and naming rules', () => {
  it('accepts only 7/30/90 days, defaults to 30, never "forever"', () => {
    expect(ALLOWED_EXPIRY_DAYS).toEqual([7, 30, 90]);
    expect(parseExpiresInDays(undefined)).toBe(DEFAULT_EXPIRY_DAYS);
    expect(DEFAULT_EXPIRY_DAYS).toBe(30);
    expect(parseExpiresInDays(7)).toBe(7);
    expect(parseExpiresInDays('90')).toBe(90);
    for (const bad of [0, 1, 14, 31, 91, 365, -30, 'forever', 'never', Infinity, NaN, 30.5, '30d']) {
      expect(parseExpiresInDays(bad as any)).toBeNull();
    }
  });

  it('computes the expiry date', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(computeExpiry(7, now).toISOString()).toBe('2026-01-08T00:00:00.000Z');
    expect(computeExpiry(90, now).toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('validates names (non-empty, <= 50)', () => {
    expect(validateTokenName('  my-agent ')).toEqual({ ok: true, name: 'my-agent' });
    expect(validateTokenName('a'.repeat(50)).ok).toBe(true);
    expect(validateTokenName('a'.repeat(51)).ok).toBe(false);
    expect(validateTokenName('   ').ok).toBe(false);
    expect(validateTokenName(undefined).ok).toBe(false);
    expect(validateTokenName(123).ok).toBe(false);
  });

  it('classifies state: active / expired / revoked, and counts only active', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const active = { expires_at: '2026-06-02T00:00:00Z', revoked_at: null };
    const expired = { expires_at: '2026-05-31T00:00:00Z', revoked_at: null };
    const exactlyNow = { expires_at: '2026-06-01T00:00:00Z', revoked_at: null };
    const revoked = { expires_at: '2026-06-02T00:00:00Z', revoked_at: '2026-05-30T00:00:00Z' };
    expect(getTokenState(active, now)).toBe('active');
    expect(getTokenState(expired, now)).toBe('expired');
    expect(getTokenState(exactlyNow, now)).toBe('expired');
    expect(getTokenState(revoked, now)).toBe('revoked');
    expect(countActiveTokens([active, expired, revoked, exactlyNow], now)).toBe(1);
  });

  it('public token view never carries the hash', () => {
    const view = toPublicToken(
      {
        id: '1', user_id: 'u', name: 'n', token_hash: 'deadbeef', prefix: 'abcd1234',
        created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', last_used_at: null, revoked_at: null,
      }
    );
    expect(JSON.stringify(view)).not.toContain('deadbeef');
    expect(view.display).toBe('anim_pat_abcd1234…');
    expect(view.status).toBe('active');
  });
});

describe('scope allowlist', () => {
  const allowed: [string, string][] = [
    ['GET', '/api/quota'],
    ['GET', '/api/auth/session'],
    ['GET', '/api/workflows'],
    ['GET', '/api/videos'],
    ['GET', '/api/video/abc123'],
    ['GET', '/api/video/abc123/status'],
    ['GET', '/api/video/abc123/download'],
    ['GET', '/media/wan/some-file.mp4'],
    ['POST', '/api/uploads'],
    ['POST', '/api/video/update'],
    ['POST', '/api/i2v/kickoff'],
    ['POST', '/api/video/abc123/reopen'],
    ['POST', '/api/video/abc123/retry'],
    ['POST', '/api/video/reuse'],
    ['POST', '/api/video/resolve-ref'],
  ];

  it.each(allowed)('allows %s %s', (method, path) => {
    expect(isRouteAllowedForToken(method, path)).toBe(true);
  });

  it('documents exactly the endpoints it allows', () => {
    expect(TOKEN_ALLOWED_ENDPOINTS).toHaveLength(allowed.length);
    for (const entry of TOKEN_ALLOWED_ENDPOINTS) {
      const [method, pattern] = entry.split(' ');
      const concrete = pattern.replace('{id}', 'abc123').replace('/**', '/x/y.mp4');
      expect(isRouteAllowedForToken(method, concrete)).toBe(true);
    }
  });

  const denied: [string, string, string][] = [
    ['PUT', '/api/profile/update', 'profile update'],
    ['POST', '/api/profile/change-password', 'password change'],
    ['POST', '/api/profile/claim-sponsor', 'sponsor claim'],
    ['POST', '/api/profile/tokens', 'token creation'],
    ['GET', '/api/profile/tokens', 'token listing'],
    ['DELETE', '/api/profile/tokens/abc', 'token revocation'],
    ['POST', '/api/auth', 'login/register'],
    ['POST', '/api/logout', 'logout'],
    ['GET', '/api/admin/settings', 'admin api'],
    ['POST', '/api/admin/workflows', 'admin api write'],
    ['GET', '/admin', 'admin page'],
    ['GET', '/admin/videos', 'admin page'],
    ['POST', '/api/video/abc/like', 'like'],
    ['GET', '/api/gallery/short', 'gallery'],
    ['DELETE', '/api/video/abc', 'video delete'],
    ['POST', '/api/video/abc/enhance-prompt', 'server-side LLM call, not part of agent mode'],
    ['POST', '/api/video/abc/analyze', 'analyze'],
    ['POST', '/api/worker/task', 'worker'],
    ['POST', '/api/i2v-webhook/abc', 'webhook'],
    ['POST', '/new', 'legacy form upload'],
    ['GET', '/profile', 'profile page'],
    ['GET', '/api/health', 'health'],
    ['GET', '/image/foo', 'image proxy'],
  ];

  it.each(denied)('denies %s %s (%s)', (method, path) => {
    expect(isRouteAllowedForToken(method, path)).toBe(false);
  });

  it('is method-strict', () => {
    expect(isRouteAllowedForToken('POST', '/api/quota')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/api/uploads')).toBe(false);
    expect(isRouteAllowedForToken('DELETE', '/api/video/abc')).toBe(false);
    expect(isRouteAllowedForToken('PUT', '/api/video/update')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/api/i2v/kickoff')).toBe(false);
  });

  it('does not accept look-alike paths (prefix, trailing slash, extra segments, traversal)', () => {
    expect(isRouteAllowedForToken('GET', '/api/quota/')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/api/quota/extra')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/api/quotas')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/x/api/quota')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/api/video/a/b')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/api/video/a/status/extra')).toBe(false);
    expect(isRouteAllowedForToken('POST', '/api/video/a/b/retry')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/media')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/medias/x')).toBe(false);
    expect(isRouteAllowedForToken('GET', '/API/quota')).toBe(false);
  });

  it('flags only uploads and kickoff as heavy', () => {
    expect(isHeavyTokenRoute('POST', '/api/uploads')).toBe(true);
    expect(isHeavyTokenRoute('POST', '/api/i2v/kickoff')).toBe(true);
    expect(isHeavyTokenRoute('GET', '/api/quota')).toBe(false);
    expect(isHeavyTokenRoute('POST', '/api/video/update')).toBe(false);
  });
});
