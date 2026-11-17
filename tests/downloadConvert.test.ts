import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FfmpegLimiter, FfmpegQueueFullError } from '../src/lib/server/ffmpegLimiter';
import { FfmpegTimeoutError, runFfmpeg } from '../src/lib/server/ffmpegRun';
import { FPS_PRESETS, SCALE_PRESETS, parseFps, parseScale } from '../src/lib/server/downloadPresets';
import { DownloadCache } from '../src/lib/server/downloadCache';

const flush = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('FfmpegLimiter', () => {
  it('runs at most maxConcurrent at once, queues in FIFO order, 429s past maxQueue', async () => {
    const lim = new FfmpegLimiter(2, 3);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const task = (n: string) =>
      lim.run(
        () =>
          new Promise<void>((res) => {
            started.push(n);
            releases.push(res);
          }),
      );

    const ps = ['a', 'b', 'c', 'd', 'e'].map(task); // 2 running + 3 queued
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(lim.activeCount).toBe(2);
    expect(lim.queuedCount).toBe(3);

    // 6th: queue full -> rejected immediately, nothing changes
    await expect(lim.run(async () => 'x')).rejects.toBeInstanceOf(FfmpegQueueFullError);
    expect(lim.queuedCount).toBe(3);

    releases[0]();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(lim.activeCount).toBe(2);
    expect(lim.queuedCount).toBe(2);

    releases[1]();
    releases[2]();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
    releases[3]();
    releases[4]();
    await Promise.all(ps);
    expect(lim.activeCount).toBe(0);
    expect(lim.queuedCount).toBe(0);
  });

  it('frees the slot when the task throws, and release is idempotent', async () => {
    const lim = new FfmpegLimiter(1, 0);
    await expect(lim.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lim.activeCount).toBe(0);
    const rel = await lim.acquire();
    rel();
    rel();
    expect(lim.activeCount).toBe(0);
    await expect(lim.run(async () => 1)).resolves.toBe(1);
  });

  it('carries retryAfterSeconds on the rejection', async () => {
    const lim = new FfmpegLimiter(1, 0, 42);
    const rel = await lim.acquire();
    const err = await lim.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegQueueFullError);
    expect(err.retryAfterSeconds).toBe(42);
    rel();
  });
});

describe('runFfmpeg timeout', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'dl-run-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('kills a hung process, removes the half-written tmp file and throws FfmpegTimeoutError', async () => {
    const tmp = join(dir, 'out.tmp');
    await fs.writeFile(tmp, 'partial');
    const t0 = Date.now();
    await expect(runFfmpeg(['30'], tmp, { timeoutMs: 150, bin: 'sleep' })).rejects.toBeInstanceOf(FfmpegTimeoutError);
    expect(Date.now() - t0).toBeLessThan(5000); // did not wait for the 30s sleep
    await expect(fs.stat(tmp)).rejects.toThrow();
  });

  it('resolves on exit 0 within the timeout and keeps the output', async () => {
    const tmp = join(dir, 'ok.tmp');
    await fs.writeFile(tmp, 'done');
    await expect(runFfmpeg(['0'], tmp, { timeoutMs: 5000, bin: 'sleep' })).resolves.toBeUndefined();
    await expect(fs.stat(tmp)).resolves.toBeTruthy();
  });

  it('non-zero exit removes tmp and reports stderr tail', async () => {
    const tmp = join(dir, 'bad.tmp');
    await fs.writeFile(tmp, 'x');
    await expect(runFfmpeg(['-c', 'echo oops >&2; exit 3'], tmp, { timeoutMs: 5000, bin: 'sh' }))
      .rejects.toThrow(/code 3: oops/);
    await expect(fs.stat(tmp)).rejects.toThrow();
  });

  it('missing binary rejects with a spawn error', async () => {
    await expect(runFfmpeg([], join(dir, 'n.tmp'), { timeoutMs: 1000, bin: 'definitely-not-ffmpeg-xyz' }))
      .rejects.toThrow(/spawn/);
  });
});

describe('download presets', () => {
  it('uses the default when absent/empty', () => {
    expect(parseFps(null, 10)).toEqual({ ok: true, value: 10 });
    expect(parseScale('', 480)).toEqual({ ok: true, value: 480 });
  });
  it('accepts every preset', () => {
    for (const f of FPS_PRESETS) expect(parseFps(String(f), 10)).toEqual({ ok: true, value: f });
    for (const s of SCALE_PRESETS) expect(parseScale(String(s), 480)).toEqual({ ok: true, value: s });
  });
  it('rejects off-list, malformed and out-of-range values', () => {
    for (const v of ['7', '9', '30', '0', '-10', '10.5', '1e1', ' 10', 'abc', '10abc', '99999999']) {
      expect(parseFps(v, 10).ok, `fps=${v}`).toBe(false);
    }
    for (const v of ['321', '1280', '120', '0', '480px', '4.8e2']) {
      expect(parseScale(v, 480).ok, `scale=${v}`).toBe(false);
    }
  });
  it('the UI defaults (normal 10/480, small 8/320) are in the whitelist', () => {
    expect(FPS_PRESETS).toContain(10);
    expect(FPS_PRESETS).toContain(8);
    expect(SCALE_PRESETS).toContain(480);
    expect(SCALE_PRESETS).toContain(320);
  });
});

describe('DownloadCache sweep', () => {
  let dir: string;
  let cache: DownloadCache;
  const MIN = 60_000;
  const age = async (name: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    await fs.utimes(join(dir, name), t, t);
  };
  const exists = (name: string) => fs.stat(join(dir, name)).then(() => true, () => false);

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'dl-cache-'));
    cache = new DownloadCache({ dir, ttlMs: 10 * MIN, maxAgeMs: 30 * MIN, tmpMaxAgeMs: 5 * MIN });
  });
  afterEach(async () => {
    cache.stopSweeper();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes aged finished files and aged .tmp leftovers, keeps young ones', async () => {
    for (const n of ['old_gif_10_480', 'young_gif_10_480', 'old_gif_10_480.tmp', 'young.tmp']) {
      await fs.writeFile(join(dir, n), 'x');
    }
    await age('old_gif_10_480', 31 * MIN);
    await age('young_gif_10_480', 11 * MIN); // past TTL (not served) but not yet swept
    await age('old_gif_10_480.tmp', 6 * MIN);
    await age('young.tmp', 1 * MIN);

    expect(await cache.sweep()).toBe(2);
    expect(await exists('old_gif_10_480')).toBe(false);
    expect(await exists('old_gif_10_480.tmp')).toBe(false);
    expect(await exists('young_gif_10_480')).toBe(true);
    expect(await exists('young.tmp')).toBe(true);
  });

  it('does not touch files being generated (.tmp) or streamed, even when old', async () => {
    const out = cache.filePath('v1', 'gif', 10, 480);
    const name = 'v1_gif_10_480';
    await fs.writeFile(out, 'x');
    await fs.writeFile(`${out}.tmp`, 'x');
    await age(name, 60 * MIN);
    await age(`${name}.tmp`, 60 * MIN);

    const release = cache.hold(out);
    expect(await cache.sweep()).toBe(0);
    expect(await exists(name)).toBe(true);
    expect(await exists(`${name}.tmp`)).toBe(true);

    const release2 = cache.hold(out); // second reader
    release();
    expect(await cache.sweep()).toBe(0); // still leased once
    release2();
    release2(); // idempotent
    expect(await cache.sweep()).toBe(2);
  });

  it('fresh() honours the TTL, ignores missing files; sweep tolerates a missing dir and subdirs', async () => {
    const p = cache.filePath('v2', 'webp', 10, 480);
    expect(await cache.fresh(p)).toBeNull();
    await fs.writeFile(p, 'x');
    expect(await cache.fresh(p)).toBe(p);
    await age('v2_webp_10_480', 11 * MIN);
    expect(await cache.fresh(p)).toBeNull();

    await fs.mkdir(join(dir, 'subdir'));
    await age('subdir', 99 * MIN);
    await cache.sweep();
    expect(await exists('subdir')).toBe(true);

    const gone = new DownloadCache({ dir: join(dir, 'nope'), ttlMs: 1, maxAgeMs: 1, tmpMaxAgeMs: 1 });
    expect(await gone.sweep()).toBe(0);
  });

  it('startSweeper sweeps immediately and periodically on an unref-ed timer', async () => {
    await fs.writeFile(join(dir, 'a_gif_10_480'), 'x');
    await age('a_gif_10_480', 31 * MIN);
    cache.startSweeper(40);
    await sleep(20);
    expect(await exists('a_gif_10_480')).toBe(false);

    await fs.writeFile(join(dir, 'b_gif_10_480'), 'x');
    await age('b_gif_10_480', 31 * MIN);
    await sleep(150);
    expect(await exists('b_gif_10_480')).toBe(false);
    cache.stopSweeper();
  });
});
