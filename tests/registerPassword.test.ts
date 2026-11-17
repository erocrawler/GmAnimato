import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ registered: [] as any[] }));
vi.mock('$lib/auth', () => ({
  authenticateUser: async () => ({ id: 'u1', username: 'old', roles: ['free'] }),
  registerUser: async (u: string, p: string) => { h.registered.push([u, p]); return { id: 'u2', username: u, roles: ['free'] }; },
}));
vi.mock('$lib/db', () => ({
  getAdminSettings: async () => ({ registrationEnabled: true }),
  createSession: async () => {},
}));
vi.mock('$lib/rateLimit', () => ({ authRateLimiter: { consume: () => ({ allowed: true, retryAfterSeconds: 0 }) } }));
vi.mock('$lib/session', () => ({
  JWT_ENABLED: false,
  generateJWT: () => null,
  generateSessionToken: () => 'tok',
  getSessionExpiry: () => new Date(Date.now() + 1000),
  SESSION_COOKIE_OPTIONS: {},
}));

import { POST } from '../src/routes/api/auth/+server';

async function post(body: any) {
  const request = new Request('https://animato.test/api/auth', { method: 'POST', body: JSON.stringify(body) });
  const cookies = { set: () => {}, get: () => undefined, delete: () => {} };
  return (POST as any)({ request, cookies, getClientAddress: () => '1.2.3.4' }) as Promise<Response>;
}

describe('register password length', () => {
  beforeEach(() => { h.registered.length = 0; });

  it('rejects < 6 chars with 400 password_too_short and does not create the user', async () => {
    const res = await post({ action: 'register', username: 'newbie', password: '12345' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Password must be at least 6 characters', errorCode: 'password_too_short' });
    expect(h.registered).toEqual([]);
  });

  it('accepts exactly 6 chars', async () => {
    const res = await post({ action: 'register', username: 'newbie', password: '123456' });
    expect(res.status).toBe(200);
    expect(h.registered).toEqual([['newbie', '123456']]);
  });

  it('login is not length-restricted (legacy short passwords still work)', async () => {
    const res = await post({ action: 'login', username: 'old', password: 'abc' });
    expect(res.status).toBe(200);
  });
});
