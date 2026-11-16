import { beforeEach, describe, expect, it, vi } from 'vitest';

// claim-sponsor PUT against an in-memory db and a fake sponsor list: no network.
const h = vi.hoisted(() => ({
  settings: {} as any,
  claims: [] as any[],
  updatedUsers: [] as any[],
  sponsors: [] as any[],
}));

vi.mock('$lib/db', () => ({
  getAdminSettings: async () => h.settings,
  getSponsorClaimByUsername: async (u: string) => h.claims.find((c) => c.sponsor_username === u),
  createSponsorClaim: async (c: any) => { h.claims.push({ id: 'c' + h.claims.length, ...c }); return c; },
  deleteSponsorClaim: async () => true,
  updateSponsorClaim: async () => null,
  updateUser: async (id: string, patch: any) => { h.updatedUsers.push({ id, ...patch }); return { id, username: 'alice', email: 'a@x', roles: patch.roles, created_at: 'x', updated_at: 'x' }; },
}));
vi.mock('$env/dynamic/private', () => ({ env: { SPONSOR_API_URL: 'http://crawler.test', SPONSOR_API_TOKEN: 't' } }));

import { PUT } from '../src/routes/api/profile/claim-sponsor/+server';

const user = () => ({ id: 'u1', username: 'alice', email: 'a@x', roles: ['free'], created_at: 'x', updated_at: 'x' });

function put(body: any) {
  const request = new Request('http://x/api/profile/claim-sponsor', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return PUT({ request, locals: { user: user() }, cookies: {} } as any);
}

describe('claim-sponsor PUT', () => {
  beforeEach(() => {
    h.claims = []; h.updatedUsers = [];
    h.sponsors = [{ fansDomainName: 'bob', fansNickname: 'Bob', fansAvatar: '', schemeName: 'Bronze' }];
    h.settings = {
      sponsorApiUrl: 'http://crawler.test', sponsorApiToken: 't',
      roles: [
        { name: 'free' },
        { name: 'bronze', sponsorTier: 'Bronze', allowAdvancedFeatures: false },
        { name: 'gold', sponsorTier: 'Gold', allowAdvancedFeatures: true },
        { name: 'admin' },
        { name: 'trap', sponsorTier: 'admin' },
      ],
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ sponsors: h.sponsors }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });

  it('grants the role that the sponsor tier maps to', async () => {
    const res = await put({ username: 'bob', roleToApply: 'bronze' });
    expect(res.status).toBe(200);
    expect(h.updatedUsers[0].roles).toContain('bronze');
    expect(h.claims).toHaveLength(1);
  });

  it('matches the tier case-insensitively', async () => {
    h.sponsors[0].schemeName = 'BRONZE';
    expect((await put({ username: 'bob', roleToApply: 'bronze' })).status).toBe(200);
  });

  it('refuses a higher tier role than the sponsor paid for', async () => {
    const res = await put({ username: 'bob', roleToApply: 'gold' });
    expect(res.status).toBe(400);
    expect((await res.json()).messageCode).toBe('INVALID_ROLE');
    expect(h.updatedUsers).toHaveLength(0);
    expect(h.claims).toHaveLength(0);
  });

  it('refuses admin even though it exists in the settings', async () => {
    const res = await put({ username: 'bob', roleToApply: 'admin' });
    expect(res.status).toBe(400);
    expect(h.updatedUsers).toHaveLength(0);
  });

  it('refuses admin even if a tier is mapped to it', async () => {
    h.settings.roles.push({ name: 'Admin', sponsorTier: 'Bronze' });
    h.settings.roles = h.settings.roles.filter((r: any) => r.name !== 'bronze');
    const res = await put({ username: 'bob', roleToApply: 'Admin' });
    expect(res.status).toBe(400);
    expect(h.updatedUsers).toHaveLength(0);
  });

  it('refuses a tier that has no role mapping', async () => {
    h.sponsors[0].schemeName = 'Platinum';
    const res = await put({ username: 'bob', roleToApply: 'gold' });
    expect(res.status).toBe(400);
    expect(h.updatedUsers).toHaveLength(0);
  });

  it('still rejects a name that is not on the sponsor list', async () => {
    const res = await put({ username: 'mallory', roleToApply: 'bronze' });
    expect(res.status).toBe(400);
    expect((await res.json()).messageCode).toBe('VERIFICATION_FAILED');
  });
});
