import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAdminGatedPath } from '../src/lib/adminGate';

const h = vi.hoisted(() => ({ users: new Map<string, any>() }));
vi.mock('$lib/db', () => ({
  getSessionByToken: async () => undefined,
  getUserById: async (id: string) => h.users.get(id),
  deleteSession: async () => true,
  deleteExpiredSessions: async () => 0,
  getAllSponsorClaims: async () => [],
  deleteSponsorClaim: async () => false,
  expireSponsorClaim: async () => false,
  updateSponsorClaim: async () => null,
  updateUser: async () => null,
  getAdminSettings: async () => ({}),
  getApiTokenByHash: async () => undefined,
  touchApiToken: async () => {},
}));
vi.mock('$app/environment', () => ({ building: true, dev: false, browser: false, version: 'test' }));
vi.mock('$lib/session', () => ({
  isSessionExpired: () => true,
  verifyJWT: (t: string) => (t === 'user.jwt' ? { id: 'u1', username: 'alice', roles: ['free'] } : t === 'admin.jwt' ? { id: 'a1', username: 'root', roles: ['admin'] } : null),
  JWT_ENABLED: true,
  generateJWT: () => null,
  SESSION_COOKIE_OPTIONS: {},
}));

import { handle } from '../src/hooks.server';

function makeEvent(url: string, jwt: string) {
  return {
    request: new Request(url),
    url: new URL(url),
    isDataRequest: false,
    locals: {} as any,
    cookies: { get: (n: string) => (n === 'session' ? jwt : undefined), set: () => {}, delete: () => {} },
  } as any;
}

async function run(path: string, jwt: string) {
  const resolve = async () => new Response('ok', { status: 200 });
  try {
    return { res: (await (handle as any)({ event: makeEvent('https://animato.test' + path, jwt), resolve })) as Response };
  } catch (e: any) {
    return { thrown: e };
  }
}

describe('isAdminGatedPath', () => {
  it('gates canonically-equal admin paths', () => {
    for (const p of ['/admin', '/admin/', '/admin/users', '/api/admin/x', '/api/%61dmin/x', '/%61dmin', '//api/admin/x',
      '/api//admin///x', '/api/admin%2fx', '/api/admin/', '/api/%2561dmin/x', '/%E0%A4%A', '/admin%']) {
      expect(isAdminGatedPath(p), p).toBe(true);
    }
  });
  it('does not gate ordinary paths', () => {
    for (const p of ['/', '/login', '/api/quota', '/api/auth', '/gallery/admin-notes', '/api/videos/admin', '/media/a/b.mp4']) {
      expect(isAdminGatedPath(p), p).toBe(false);
    }
  });
});

describe('hooks: admin gate end to end', () => {
  beforeEach(() => {
    h.users.clear();
    h.users.set('u1', { id: 'u1', username: 'alice', roles: ['free'] });
    h.users.set('a1', { id: 'a1', username: 'root', roles: ['admin'] });
  });

  it('non-admin is redirected to / for every spelling', async () => {
    for (const p of ['/api/admin/x', '/api/%61dmin/x', '/%61dmin', '//api/admin/x', '/api/admin%2fx', '/admin/', '/api/admin/x/']) {
      const { res, thrown } = await run(p, 'user.jwt');
      expect(res, p).toBeUndefined();
      expect(thrown?.status, p).toBe(303);
      expect(thrown?.location, p).toBe('/');
    }
  });

  it('admin passes', async () => {
    for (const p of ['/api/admin/x', '/api/%61dmin/x', '/%61dmin', '//api/admin/x']) {
      const { res } = await run(p, 'admin.jwt');
      expect(res?.status, p).toBe(200);
    }
  });

  it('ordinary paths are unaffected for non-admins', async () => {
    for (const p of ['/api/quota', '/gallery', '/']) {
      const { res } = await run(p, 'user.jwt');
      expect(res?.status, p).toBe(200);
    }
  });
});
