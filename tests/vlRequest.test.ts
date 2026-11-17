import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// imageRecognition reads its config from $env at import time; mock the env and
// fetch so nothing touches a real VL backend.
const h = vi.hoisted(() => ({
  env: {
    CUSTOM_VL_URL: 'http://vl.test/v1/chat/completions',
    CUSTOM_VL_AUTH_MODE: 'bearer',
    CUSTOM_VL_API_KEY: 'test-key',
    CUSTOM_VL_MODEL: 'test-model',
    CUSTOM_VL_MAX_TOKENS: '512',
  } as Record<string, string | undefined>,
}));
vi.mock('$env/dynamic/private', () => ({ env: h.env }));
vi.mock('sharp', () => ({ default: () => ({}) }));

import {
  buildVlRequestBody,
  normalizeAnnotation,
  requestCustomVlJson,
  isTransientStructuredOutputError,
  VL_JSON_MAX_ATTEMPTS,
} from '../src/lib/imageRecognition';

const MSGS = [{ role: 'user' as const, content: 'hi' }];

describe('buildVlRequestBody', () => {
  it('lets the caller temperature win over the template', () => {
    const body = buildVlRequestBody({ temperature: 1.0, top_p: 0.95 }, MSGS, 0.7, 100);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.95);
  });

  it('uses the caller temperature when the template has none', () => {
    const body = buildVlRequestBody({ response_format: { type: 'json_object' } }, MSGS, 0.2, 100);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('keeps messages/max_tokens/model semantics and does not let the template override them', () => {
    const body = buildVlRequestBody({ messages: 'x', max_tokens: 1, model: 'tmpl' }, MSGS, 0.7, 77, 'm1');
    expect(body.messages).toBe(MSGS);
    expect(body.max_tokens).toBe(77);
    expect(body.model).toBe('m1');
    const noModel = buildVlRequestBody({ top_k: 20 }, MSGS, 0.7, undefined);
    expect('model' in noModel).toBe(false);
    expect(noModel.max_tokens).toBe(512); // CUSTOM_VL_MAX_TOKENS default
    expect(noModel.top_k).toBe(20);
  });

  it('shipped strata templates no longer pin a temperature', () => {
    const dir = path.join(process.cwd(), 'config', 'vl-templates');
    for (const f of ['strata.json', 'strata-think.json']) {
      const tpl = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(tpl).not.toHaveProperty('temperature');
      expect(tpl.top_p).toBe(0.95);
      expect(tpl.top_k).toBe(20);
    }
    const llama = JSON.parse(fs.readFileSync(path.join(dir, 'llama.json'), 'utf8'));
    expect(llama.response_format).toEqual({ type: 'json_object' });
  });
});

describe('normalizeAnnotation', () => {
  const base = { suggested_prompts: ['a', 'b'], tags: ['1girl'], is_photo_realistic: false, is_nsfw: false };

  it('passes a well-formed response (trimming strings)', () => {
    expect(normalizeAnnotation({ ...base, suggested_prompts: ['  a  ', 'b'] })).toEqual(base);
  });

  it('unwraps object suggestions via prompt/text/description/content', () => {
    const out = normalizeAnnotation({
      ...base,
      suggested_prompts: [{ prompt: 'p1' }, { text: 't2' }],
    });
    expect(out?.suggested_prompts).toEqual(['p1', 't2']);
    const out2 = normalizeAnnotation({
      ...base,
      suggested_prompts: [{ description: 'd1' }, { content: 'c2' }],
    });
    expect(out2?.suggested_prompts).toEqual(['d1', 'c2']);
    // mixed strings and objects; extra elements beyond two are dropped
    const out3 = normalizeAnnotation({ ...base, suggested_prompts: ['s', { prompt: 'o' }, 'third'] });
    expect(out3?.suggested_prompts).toEqual(['s', 'o']);
  });

  it('never produces "[object Object]"', () => {
    const cases: unknown[] = [
      { ...base, suggested_prompts: [{ prompt: 'p1' }, { text: 't2' }] },
      { ...base, suggested_prompts: [{ foo: 1 }, 'b'] },
      { ...base, suggested_prompts: [{ prompt: '' }, 'b'] },
      { ...base, tags: [{ tag: 'x' }, { weird: 1 }, 'y'] },
    ];
    for (const c of cases) expect(JSON.stringify(normalizeAnnotation(c))).not.toContain('[object Object]');
  });

  it('rejects suggestions that cannot be turned into strings', () => {
    for (const bad of [{ foo: 'x' }, { prompt: '' }, { prompt: 5 }, 5, null, undefined, ['nested'], true, '   ']) {
      expect(normalizeAnnotation({ ...base, suggested_prompts: [bad, 'b'] })).toBeNull();
      expect(normalizeAnnotation({ ...base, suggested_prompts: ['a', bad] })).toBeNull();
    }
  });

  it('rejects fewer than 2 valid suggestions and non-array suggestions', () => {
    expect(normalizeAnnotation({ ...base, suggested_prompts: ['only one'] })).toBeNull();
    expect(normalizeAnnotation({ ...base, suggested_prompts: [] })).toBeNull();
    expect(normalizeAnnotation({ ...base, suggested_prompts: 'a, b' })).toBeNull();
    expect(normalizeAnnotation({ ...base, suggested_prompts: undefined })).toBeNull();
  });

  it('keeps string/object tags, drops the rest, allows empty', () => {
    const out = normalizeAnnotation({
      ...base,
      tags: ['solo', ' smile ', '', '  ', { tag: 'long_hair' }, { name: 'n' }, { label: 'l' }, { other: 'x' }, 3, null, ['x'], true],
    });
    expect(out?.tags).toEqual(['solo', 'smile', 'long_hair', 'n', 'l']);
    expect(normalizeAnnotation({ ...base, tags: [] })?.tags).toEqual([]);
    expect(normalizeAnnotation({ ...base, tags: 'solo' })).toBeNull();
  });

  it('requires real booleans', () => {
    expect(normalizeAnnotation({ ...base, is_photo_realistic: 'true' })).toBeNull();
    expect(normalizeAnnotation({ ...base, is_nsfw: 0 })).toBeNull();
    expect(normalizeAnnotation({ ...base, is_nsfw: undefined })).toBeNull();
    expect(normalizeAnnotation({ ...base, is_photo_realistic: true, is_nsfw: true })).toMatchObject({
      is_photo_realistic: true,
      is_nsfw: true,
    });
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'x', 3, [], [base]]) expect(normalizeAnnotation(bad)).toBeNull();
  });
});

describe('requestCustomVlJson retry', () => {
  const okJson = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const good = JSON.stringify({ suggested_prompts: ['a', 'b'], tags: [], is_photo_realistic: true, is_nsfw: false });
  const wrongShape = JSON.stringify({ suggested_prompts: [{ foo: 1 }, { bar: 2 }], tags: [], is_photo_realistic: true, is_nsfw: false });
  let fetchMock: ReturnType<typeof vi.fn>;

  function queue(...responses: Array<string | Error | Response>) {
    fetchMock = vi.fn(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected extra fetch');
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? okJson(next) : next;
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows three attempts in total', () => {
    expect(VL_JSON_MAX_ATTEMPTS).toBe(3);
  });

  it('sends the caller temperature, not a template value', async () => {
    queue(good);
    await requestCustomVlJson(MSGS, 0.2);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(sent.temperature).toBe(0.2);
  });

  it('retries invalid JSON twice and succeeds on the third attempt', async () => {
    queue('{"suggested_prompts": ["x', 'not json at all {', good);
    const r = await requestCustomVlJson(MSGS, 0.7, undefined, normalizeAnnotation);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.valid?.suggested_prompts).toEqual(['a', 'b']);
  });

  it('retries wrong-shape JSON (validate returns null) like a parse failure', async () => {
    queue(wrongShape, wrongShape, good);
    const r = await requestCustomVlJson(MSGS, 0.7, undefined, normalizeAnnotation);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.valid).not.toBeNull();
  });

  it('stops retrying after the first valid response', async () => {
    queue(wrongShape, good);
    const r = await requestCustomVlJson(MSGS, 0.7, undefined, normalizeAnnotation);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.valid).not.toBeNull();
  });

  it('returns invalid (does not throw) when all three attempts fail', async () => {
    queue(wrongShape, wrongShape, wrongShape);
    const r = await requestCustomVlJson(MSGS, 0.7, undefined, normalizeAnnotation);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.valid).toBeNull();
    expect(r.parsed).not.toBeNull();
    expect(r.text).toBe(wrongShape);
  });

  it('returns parsed=null/valid=null when all attempts are unparsable', async () => {
    queue('{{{', '{{{', '{{{');
    const r = await requestCustomVlJson(MSGS, 0.7);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.parsed).toBeNull();
    expect(r.valid).toBeNull();
  });

  it('without a validator, valid is the parsed value (evaluate/relay callers)', async () => {
    queue('{"is_photo_realistic": true, "is_nsfw": false}');
    const r = await requestCustomVlJson<{ is_nsfw: boolean }>(MSGS, 0.2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.valid).toEqual(r.parsed);
    expect(r.valid?.is_nsfw).toBe(false);
  });

  it('still retries transient 502/structured_output_failed errors', async () => {
    queue(new Response('structured_output_failed', { status: 502 }), new Response('bad gateway', { status: 502 }), good);
    const r = await requestCustomVlJson(MSGS, 0.7, undefined, normalizeAnnotation);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.valid).not.toBeNull();
  });

  it('throws after the last attempt on persistent 502, and does not retry other errors', async () => {
    queue(...[1, 2, 3].map(() => new Response('x', { status: 502 })));
    await expect(requestCustomVlJson(MSGS, 0.7)).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    queue(new Response('nope', { status: 400 }));
    await expect(requestCustomVlJson(MSGS, 0.7)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies transient errors', () => {
    expect(isTransientStructuredOutputError(new Error('Custom VL request failed (502): x'))).toBe(true);
    expect(isTransientStructuredOutputError(new Error('structured_output_failed'))).toBe(true);
    expect(isTransientStructuredOutputError(new Error('Custom VL request failed (400): x'))).toBe(false);
  });
});
