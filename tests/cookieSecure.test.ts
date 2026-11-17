import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: h.env }));

import { cookieSecure, SESSION_COOKIE_OPTIONS } from '../src/lib/session';

describe('cookieSecure', () => {
  beforeEach(() => { for (const k of Object.keys(h.env)) delete h.env[k]; });

  it('COOKIE_SECURE true/1 wins, even outside production', () => {
    for (const v of ['true', '1', 'TRUE', ' true ']) {
      h.env.COOKIE_SECURE = v;
      h.env.NODE_ENV = 'development';
      expect(cookieSecure(), v).toBe(true);
    }
  });

  it('COOKIE_SECURE false/0 wins, even in production', () => {
    for (const v of ['false', '0']) {
      h.env.COOKIE_SECURE = v;
      h.env.NODE_ENV = 'production';
      expect(cookieSecure(), v).toBe(false);
    }
  });

  it('falls back to NODE_ENV === production when COOKIE_SECURE is unset/empty/unknown', () => {
    for (const v of [undefined, '', 'maybe']) {
      h.env.COOKIE_SECURE = v;
      h.env.NODE_ENV = 'production';
      expect(cookieSecure()).toBe(true);
      h.env.NODE_ENV = undefined;
      expect(cookieSecure()).toBe(false);
    }
  });

  it('SESSION_COOKIE_OPTIONS.secure is resolved at read time and survives spreading', () => {
    h.env.COOKIE_SECURE = 'false';
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(false);
    h.env.COOKIE_SECURE = 'true';
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(true);
    expect({ ...SESSION_COOKIE_OPTIONS, expires: new Date(0) }.secure).toBe(true);
    expect(SESSION_COOKIE_OPTIONS).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax', maxAge: 604800 });
  });
});
