import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { isHttpError, isRedirect } from '@sveltejs/kit';

// The GmGard callback runs against an in-memory user table with the same semantics as the real
// DB methods (see tests/pg/pgIntegration.test.ts for the real-Postgres counterpart).
const h = vi.hoisted(() => ({
  users: [] as any[],
  sessions: [] as any[],
  userInfo: {} as any,
  tokenError: null as any,
  linkOverride: null as null | ((userId: string, provider: string, sub: string) => Promise<boolean> | boolean),
  createOverride: null as null | ((input: any) => any),
  calls: { link: [] as any[], create: [] as any[] },
  nextId: 1,
  hideFromIdentityOnce: false,
}));

const ACCESS_TOKEN = 'at-SECRET-ACCESS-TOKEN-0123456789abcdef';
const EMAIL = 'victim@example.test';

vi.mock('$lib/oauth', () => ({
  exchangeCodeForTokens: async () => {
    if (h.tokenError) throw h.tokenError;
    return { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 };
  },
  getUserInfo: async () => h.userInfo,
}));
vi.mock('$lib/session', () => ({
  JWT_ENABLED: false,
  generateJWT: () => null,
  generateSessionToken: () => 'sess-token',
  getSessionExpiry: () => new Date('2030-01-01T00:00:00Z'),
  SESSION_COOKIE_OPTIONS: { path: '/', httpOnly: true },
}));
vi.mock('$lib/db', () => ({
  getUserByUsername: async (username: string) => h.users.find((u) => u.username === username),
  getUserByOAuthIdentity: async (provider: string, sub: string) => {
    if (h.hideFromIdentityOnce) { h.hideFromIdentityOnce = false; return undefined; }
    return h.users.find((u) => u.oauth_provider === provider && u.oauth_sub === sub);
  },
  linkOAuthIdentity: async (userId: string, provider: string, sub: string) => {
    h.calls.link.push({ userId, provider, sub });
    if (h.linkOverride) return h.linkOverride(userId, provider, sub);
    const u = h.users.find((x) => x.id === userId);
    if (!u || u.oauth_sub) return false;
    if (h.users.some((x) => x.oauth_provider === provider && x.oauth_sub === sub)) return false;
    u.oauth_provider = provider;
    u.oauth_sub = sub;
    return true;
  },
  createOAuthUser: async (input: any) => {
    h.calls.create.push(input);
    if (h.createOverride) {
      const r = h.createOverride(input);
      if (r !== undefined) return r;
    }
    if (h.users.some((u) => u.username === input.username)) return null;
    if (input.email && h.users.some((u) => u.email === input.email)) return null;
    if (h.users.some((u) => u.oauth_provider === input.provider && u.oauth_sub === input.sub)) return null;
    const u = {
      id: `u${h.nextId++}`, username: input.username, email: input.email, password_hash: input.password_hash,
      roles: input.roles, oauth_provider: input.provider, oauth_sub: input.sub, created_at: 'x',
    };
    h.users.push(u);
    return u;
  },
  createSession: async (user_id: string, token: string) => { h.sessions.push({ user_id, token }); },
}));

import { load } from '../src/routes/auth/gmgard/callback/+page.server';

const seedUser = (over: any) => {
  const u = { id: `u${h.nextId++}`, email: undefined, password_hash: 'x', roles: [], created_at: 'x', ...over };
  h.users.push(u);
  return u;
};
const bcryptHash = bcrypt.hashSync('local-secret', 4);

function makeCookies() {
  const store: Record<string, string> = { oauth_state: 'st', oauth_verifier: 'ver' };
  const set = vi.fn(); const del = vi.fn();
  return { get: (k: string) => store[k], set, delete: del } as any;
}
async function run(): Promise<any> {
  const cookies = makeCookies();
  try {
    await load({ url: new URL('http://x/auth/gmgard/callback?code=c&state=st'), cookies } as any);
    return { thrown: null, cookies };
  } catch (e) {
    return { thrown: e, cookies };
  }
}
const loggedIn = (r: any) => isRedirect(r.thrown) && r.thrown.status === 302 && r.thrown.location === '/';
const httpStatus = (r: any) => (isHttpError(r.thrown) ? r.thrown.status : null);

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
const logged = () =>
  logSpies.flatMap((s) => s.mock.calls).map((args) => args.map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n');

beforeEach(() => {
  h.users = []; h.sessions = []; h.nextId = 1;
  h.userInfo = { sub: 'sub-1', preferred_username: 'alice', email: EMAIL };
  h.hideFromIdentityOnce = false; h.tokenError = null; h.linkOverride = null; h.createOverride = null;
  h.calls = { link: [], create: [] };
  logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => { logSpies.forEach((s) => s.mockRestore()); });

describe('GmGard OAuth callback: account association', () => {
  describe('(a) known identity', () => {
    it('logs the bound user in even if the GmGard username changed', async () => {
      const u = seedUser({ username: 'old-name', roles: ['gmgard-user'], oauth_provider: 'gmgard', oauth_sub: 'sub-1' });
      h.userInfo = { sub: 'sub-1', preferred_username: 'brand-new-name', email: EMAIL };
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.sessions).toEqual([{ user_id: u.id, token: 'sess-token' }]);
      expect(h.users).toHaveLength(1);
      expect(h.users[0].username).toBe('old-name');
      expect(h.calls.link).toHaveLength(0);
      expect(r.cookies.set).toHaveBeenCalledWith('session', 'sess-token', expect.anything());
    });

    it('matching sub beats a local-registered account that happens to have the new username', async () => {
      const u = seedUser({ username: 'old-name', roles: ['gmgard-user'], oauth_provider: 'gmgard', oauth_sub: 'sub-1' });
      seedUser({ username: 'alice', password_hash: bcryptHash, roles: [] });
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.sessions[0].user_id).toBe(u.id);
    });
  });

  describe('(b) legacy OAuth account without sub', () => {
    it('binds atomically on first login, then later logins go by sub (even after a rename)', async () => {
      const u = seedUser({ username: 'alice', roles: ['gmgard-user'], password_hash: 'not-a-bcrypt' });
      let r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.calls.link).toEqual([{ userId: u.id, provider: 'gmgard', sub: 'sub-1' }]);
      expect(u).toMatchObject({ oauth_provider: 'gmgard', oauth_sub: 'sub-1' });
      expect(h.users).toHaveLength(1);

      h.calls.link = [];
      h.userInfo = { sub: 'sub-1', preferred_username: 'alice-renamed' };
      r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.sessions.map((s) => s.user_id)).toEqual([u.id, u.id]);
      expect(h.calls.link).toHaveLength(0);
      expect(h.users).toHaveLength(1);
    });

    it('admin legacy OAuth account is bound the same way (no special handling)', async () => {
      const admin = seedUser({ username: 'admin', roles: ['gmgard-user', 'admin'] });
      h.userInfo = { sub: 'sub-admin', preferred_username: 'admin' };
      expect(loggedIn(await run())).toBe(true);
      expect(admin.oauth_sub).toBe('sub-admin');
    });

    it('losing the bind race to a different identity is rejected with 403, no session', async () => {
      const u = seedUser({ username: 'alice', roles: ['gmgard-user'] });
      h.linkOverride = async () => { u.oauth_sub = 'someone-else'; u.oauth_provider = 'gmgard'; return false; };
      const r = await run();
      expect(httpStatus(r)).toBe(403);
      expect(h.sessions).toHaveLength(0);
      expect(u.oauth_sub).toBe('someone-else');
    });

    it('username row already bound to the same sub (created by a concurrent request) logs in', async () => {
      const u = seedUser({ username: 'alice', roles: ['gmgard-user'], oauth_provider: 'gmgard', oauth_sub: 'sub-1' });
      h.hideFromIdentityOnce = true; // the identity lookup ran just before the other request committed
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.sessions[0].user_id).toBe(u.id);
      expect(h.calls.link).toHaveLength(0);
    });

    it('losing the bind race to the SAME identity (double submit) still logs in', async () => {
      const u = seedUser({ username: 'alice', roles: ['gmgard-user'] });
      h.linkOverride = async () => { u.oauth_sub = 'sub-1'; u.oauth_provider = 'gmgard'; return false; };
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.sessions[0].user_id).toBe(u.id);
    });
  });

  describe('(c) username already used by another account: no login, no merge', () => {
    it('local-registered account (roles []) with the same name is rejected, row untouched', async () => {
      const u = seedUser({ username: 'alice', password_hash: bcryptHash, roles: [] });
      const before = JSON.stringify(h.users);
      const r = await run();
      expect(httpStatus(r)).toBe(403);
      expect(r.thrown.body.message).toContain('已被本站其他账号占用');
      expect(h.sessions).toHaveLength(0);
      expect(h.calls.link).toHaveLength(0);
      expect(h.calls.create).toHaveLength(0);
      expect(JSON.stringify(h.users)).toBe(before);
      expect(u.oauth_sub).toBeUndefined();
      expect(r.cookies.set).not.toHaveBeenCalled();
    });

    it('a local-registered privileged account (roles admin, no gmgard-user) gets no exemption', async () => {
      seedUser({ username: 'boss', password_hash: bcryptHash, roles: ['admin'] });
      h.userInfo = { sub: 'sub-x', preferred_username: 'boss' };
      const r = await run();
      expect(httpStatus(r)).toBe(403);
      expect(h.sessions).toHaveLength(0);
      expect(h.calls.link).toHaveLength(0);
    });

    it('gmgard-user account already bound to another sub is rejected without a bind attempt', async () => {
      const u = seedUser({ username: 'alice', roles: ['gmgard-user'], oauth_provider: 'gmgard', oauth_sub: 'sub-OTHER' });
      const r = await run();
      expect(httpStatus(r)).toBe(403);
      expect(h.calls.link).toHaveLength(0);
      expect(h.sessions).toHaveLength(0);
      expect(u.oauth_sub).toBe('sub-OTHER');
    });

    it('does not auto-rename / auto-create', async () => {
      seedUser({ username: 'alice', roles: [] });
      await run();
      expect(h.users).toHaveLength(1);
      expect(h.calls.create).toHaveLength(0);
    });
  });

  describe('(d) brand-new user', () => {
    it('creates a gmgard-user bound to (gmgard, sub) with an unusable but valid bcrypt hash', async () => {
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.users).toHaveLength(1);
      const u = h.users[0];
      expect(u).toMatchObject({ username: 'alice', email: EMAIL, roles: ['gmgard-user'], oauth_provider: 'gmgard', oauth_sub: 'sub-1' });
      expect(u.password_hash).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/);
      for (const guess of ['password', '123456', 'alice', 'admin', '', 'gmgard-user', 'undefined', '0.123456789']) {
        expect(await bcrypt.compare(guess, u.password_hash)).toBe(false);
      }
      expect(h.sessions[0].user_id).toBe(u.id);
    });

    it('two accounts get different hashes (no shared / predictable secret)', async () => {
      await run();
      h.userInfo = { sub: 'sub-2', preferred_username: 'bob', email: 'bob@example.test' };
      await run();
      expect(h.users[0].password_hash).not.toBe(h.users[1].password_hash);
    });

    it('falls back to sub as username when preferred_username is missing', async () => {
      h.userInfo = { sub: 'sub-9' };
      expect(loggedIn(await run())).toBe(true);
      expect(h.users[0]).toMatchObject({ username: 'sub-9', oauth_sub: 'sub-9', email: undefined });
    });

    it('concurrent first login: unique conflict on create -> re-lookup by sub -> login', async () => {
      let winner: any;
      // the other request inserts the same identity between our lookups and our INSERT
      h.createOverride = () => {
        winner ??= seedUser({ username: 'alice', roles: ['gmgard-user'], oauth_provider: 'gmgard', oauth_sub: 'sub-1' });
        return null;
      };
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.sessions[0].user_id).toBe(winner.id);
      expect(h.users).toHaveLength(1);
    });

    it('email held by another account: retries without email and still creates the user', async () => {
      seedUser({ username: 'someone', email: EMAIL, roles: [] });
      const r = await run();
      expect(loggedIn(r)).toBe(true);
      expect(h.calls.create).toHaveLength(2);
      expect(h.calls.create[1].email).toBeUndefined();
      expect(h.users.find((u) => u.username === 'alice')).toMatchObject({ oauth_sub: 'sub-1', email: undefined });
    });

    it('unique conflict that cannot be resolved by sub is a 403, not a 500', async () => {
      h.createOverride = () => null;
      const r = await run();
      expect(httpStatus(r)).toBe(403);
      expect(h.sessions).toHaveLength(0);
    });
  });

  describe('sub validation', () => {
    for (const bad of [undefined, null, '', '   ', 123, {}]) {
      it(`rejects sub=${JSON.stringify(bad)} with 400 before touching any account`, async () => {
        seedUser({ username: 'alice', roles: ['gmgard-user'] });
        h.userInfo = { sub: bad, preferred_username: 'alice' };
        const r = await run();
        expect(httpStatus(r)).toBe(400);
        expect(h.calls.link).toHaveLength(0);
        expect(h.calls.create).toHaveLength(0);
        expect(h.sessions).toHaveLength(0);
      });
    }
  });

  describe('request validation is unchanged', () => {
    it('rejects a state mismatch with 400', async () => {
      const cookies = makeCookies();
      await expect(load({ url: new URL('http://x/cb?code=c&state=other'), cookies } as any)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('logging', () => {
    const HASH_MARK = '$2b$04$' + 'h'.repeat(53);
    const everything = async () => {
      // success (new), success (legacy bind), 403, 400, 500 with a message that embeds sensitive values
      await run();
      seedUser({ username: 'legacy', roles: ['gmgard-user'], email: EMAIL, password_hash: HASH_MARK });
      h.userInfo = { sub: 'sub-L', preferred_username: 'legacy', email: EMAIL };
      await run();
      seedUser({ username: 'taken', password_hash: HASH_MARK, email: EMAIL, roles: [] });
      h.userInfo = { sub: 'sub-T', preferred_username: 'taken', email: EMAIL };
      await run();
      h.userInfo = { sub: '', preferred_username: 'x', email: EMAIL };
      await run();
      const e: any = new Error(`Invalid prisma.user.create() invocation: data: { email: "${EMAIL}", passwordHash: "${HASH_MARK}" }`);
      e.name = 'PrismaClientKnownRequestError'; e.code = 'P2021';
      h.tokenError = e;
      h.userInfo = { sub: 'sub-1' };
      const r = await run();
      expect(httpStatus(r)).toBe(500);
      expect(r.thrown.body.message).toBe('Failed to complete authentication');
    };

    it('never logs the access token, the userinfo email or a password hash', async () => {
      await everything();
      const out = logged();
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toContain(ACCESS_TOKEN);
      expect(out).not.toContain(ACCESS_TOKEN.slice(0, 10));
      expect(out).not.toContain(EMAIL);
      expect(out).not.toContain('password_hash');
      expect(out).not.toContain('passwordHash');
      expect(out).not.toContain(HASH_MARK);
      expect(out).not.toMatch(/\$2[aby]\$/);
      for (const u of h.users) expect(out).not.toContain(u.password_hash);
    });

    it('logs only event lines: user id on success, username on conflict', async () => {
      await run();
      expect(logged()).toContain(`OAuth login ok, user id=${h.users[0].id}`);
      seedUser({ username: 'taken', roles: [] });
      h.userInfo = { sub: 'sub-T', preferred_username: 'taken' };
      await run();
      expect(logged()).toContain('OAuth username conflict');
      expect(logged()).toContain('taken');
    });
  });
});
