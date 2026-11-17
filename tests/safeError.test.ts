import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERIC_ERROR_MESSAGE, jsonServerError, safeErrorMessage } from '../src/lib/server/safe-error';

const SECRET = 'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2 at /srv/app/db.ts:42';

describe('safe-error helpers', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => spy.mockRestore());

  it('jsonServerError returns 500 + fixed message and logs the original error', async () => {
    const err = new Error(SECRET);
    const res = jsonServerError('[T] boom', err);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: GENERIC_ERROR_MESSAGE });
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('hunter2');
    expect(spy).toHaveBeenCalledWith('[T] boom', err);
  });

  it('keeps the caller-chosen status, message and static extra fields', async () => {
    const res = jsonServerError('[T]', new Error(SECRET), { status: 502, message: '上游失败', extra: { success: false } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: '上游失败' });
  });

  it('extra can never override the fixed error text', async () => {
    const res = jsonServerError('[T]', new Error(SECRET), { extra: { error: SECRET } as any });
    expect((await res.json()).error).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('handles non-Error throwables', async () => {
    const res = jsonServerError('[T]', 'plain string secret');
    expect(await res.text()).not.toContain('plain string secret');
  });

  it('safeErrorMessage logs and returns only the fixed message', () => {
    const err = new Error(SECRET);
    expect(safeErrorMessage('[T] x', err)).toBe(GENERIC_ERROR_MESSAGE);
    expect(safeErrorMessage('[T] x', err, '自定义')).toBe('自定义');
    expect(spy).toHaveBeenCalledWith('[T] x', err);
  });
});
