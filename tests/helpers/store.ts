import { JsonFileDatabase } from '../../src/lib/db-json';
import type { User } from '../../src/lib/IDatabase';
import { generateApiToken } from '../../src/lib/apiTokens';

/**
 * Test fixture: real JsonFileDatabase token methods (in-memory, no file I/O)
 * plus a Map standing in for the users table, so no database is ever touched.
 */
export function makeStore() {
  const db = new JsonFileDatabase();
  const users = new Map<string, User>();

  function addUser(id: string, username = id, roles: string[] = ['free']): User {
    const u: User = {
      id,
      username,
      email: `${username}@example.test`,
      password_hash: 'x',
      roles,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    users.set(id, u);
    return u;
  }

  async function issueToken(userId: string, opts: { days?: number; name?: string; expiresAt?: Date } = {}) {
    const g = generateApiToken();
    const record = await db.createApiToken({
      user_id: userId,
      name: opts.name ?? 'test',
      token_hash: g.hash,
      prefix: g.prefix,
      expires_at: opts.expiresAt ?? new Date(Date.now() + (opts.days ?? 30) * 86400_000),
    });
    return { raw: g.token, record };
  }

  const deps = {
    getApiTokenByHash: (h: string) => db.getApiTokenByHash(h),
    getUserById: async (id: string) => users.get(id),
    touchApiToken: (id: string, at: Date) => db.touchApiToken(id, at),
  };

  return { db, users, addUser, issueToken, deps };
}
