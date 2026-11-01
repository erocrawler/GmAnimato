import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PostgresDatabase } from '../src/lib/db-postgres';

/**
 * Guard against "added a column / a VideoEntry field but forgot to map it in the Postgres layer".
 * That happened more than once (the latest: quota_cost was computed by kickoff but silently dropped, so every video
 * stayed at the default 1). Every scalar column of the Prisma `Video` model must either round-trip through
 * createVideoEntry / updateVideo / the row mapper, or be listed below WITH a reason.
 *
 * If this test fails after you touched the schema or VideoEntry: map the field in db-postgres.ts
 * (createVideoEntry, updateVideo and mapToVideoEntry). Only add it here when the app must NOT write it.
 */

// Columns the application never writes through these methods (column -> why).
const NOT_WRITTEN_BY_APP: Record<string, string> = {
  updatedAt: 'Prisma @updatedAt',
  likesCountCache: 'maintained by a DB trigger on video_likes',
  completionTime: 'DB-maintained (BigInt, used for sorting by completion)',
};

// Per-operation exceptions, current by design. Everything not listed is required on create, update and read.
const NOT_ON_CREATE = new Set(['createdAt', 'processingTimeMs', 'progressPercentage', 'progressDetails']); // createdAt = DB default; the rest are set while a job runs
const NOT_ON_UPDATE = new Set(['id', 'createdAt']); // immutable

// Columns whose app-level value differs from the stored one (JSON strings).
const JSON_STRING_COLUMNS = new Set(['tags', 'suggestedPrompts']);

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

type Field = { name: string; kind: string; type: string };
const fields: Field[] = (Prisma.dmmf.datamodel.models.find((m) => m.name === 'Video')!.fields as unknown as Field[]).filter(
  (f) => f.kind === 'scalar'
);

/** [value as the app sees it, value as stored in the column] */
function sample(f: Field): [unknown, unknown] {
  if (JSON_STRING_COLUMNS.has(f.name)) return [['a'], '["a"]'];
  switch (f.type) {
    case 'String': return ['s-' + f.name, 's-' + f.name];
    case 'Int': return [7, 7];
    case 'Float': return [7.5, 7.5];
    case 'Boolean': return [true, true];
    case 'DateTime': return ['2026-01-02T03:04:05.000Z', new Date('2026-01-02T03:04:05.000Z')];
    case 'Json': return [{ a: 1 }, { a: 1 }];
    default: throw new Error(`no sample for ${f.name}: ${f.type} — extend sample() or list it in NOT_WRITTEN_BY_APP`);
  }
}

const baseRow = (extra: Record<string, unknown> = {}) => ({
  id: 'v1', userId: 'u1', originalImageUrl: 'https://x/a.png', status: 'uploaded', createdAt: new Date('2026-11-01T00:00:00Z'), ...extra,
});

function dbWith(video: Record<string, any>) {
  const db = new PostgresDatabase('postgresql://u:p@127.0.0.1:1/none');
  (db as any).prisma = { video };
  return db;
}

describe('Prisma Video columns are all mapped by the Postgres layer', () => {
  it('the allowlist only names real columns', () => {
    const names = new Set(fields.map((f) => f.name));
    for (const k of Object.keys(NOT_WRITTEN_BY_APP)) expect(names.has(k), `stale allowlist entry ${k}`).toBe(true);
    for (const k of [...NOT_ON_CREATE, ...NOT_ON_UPDATE]) expect(names.has(k), `stale exception ${k}`).toBe(true);
  });

  const mapped = fields.filter((f) => !(f.name in NOT_WRITTEN_BY_APP));

  it.each(mapped.map((f) => [f.name, f] as const))('%s: create writes it, update writes it, reads return it', async (name, f) => {
    const key = snake(name);
    const [appValue, dbValue] = sample(f);

    // read (via the row mapper, reached through both public methods)
    const create = vi.fn(async ({ data }: any) => baseRow({ [name]: dbValue, ...data }));
    const update = vi.fn(async ({ data }: any) => baseRow({ [name]: dbValue, ...data }));
    const db = dbWith({ create, update });

    if (!NOT_ON_CREATE.has(name)) {
      const entry: any = { user_id: 'u1', original_image_url: 'https://x/a.png', status: 'uploaded', [key]: appValue };
      const out: any = await db.createVideoEntry(entry);
      expect(create.mock.calls[0][0].data[name], `createVideoEntry must write ${name} (from ${key})`).toEqual(dbValue);
      expect(out[key], `the row mapper must return ${key} (from ${name})`).toEqual(appValue);
    } else {
      const out: any = await db.createVideoEntry({ user_id: 'u1', original_image_url: 'https://x/a.png', status: 'uploaded' } as any);
      expect(out[key], `the row mapper must return ${key} (from ${name})`).toEqual(appValue);
    }

    if (!NOT_ON_UPDATE.has(name)) {
      await db.updateVideo('v1', { [key]: appValue } as any);
      expect(update.mock.calls[0][0].data[name], `updateVideo must write ${name} (from ${key})`).toEqual(dbValue);
    }
  });
});
