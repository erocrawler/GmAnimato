import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById } from '$lib/db';
import { env } from '$env/dynamic/private';
import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { DownloadCache } from '$lib/server/downloadCache';
import { FfmpegLimiter, FfmpegQueueFullError } from '$lib/server/ffmpegLimiter';
import { FfmpegTimeoutError, runFfmpeg } from '$lib/server/ffmpegRun';
import { parseFps, parseScale } from '$lib/server/downloadPresets';

const ALLOWED_FORMATS = ['gif', 'webp'] as const;
type Format = (typeof ALLOWED_FORMATS)[number];

// GIF quality presets. "small" targets <5 MB for 6 s clips.
const GIF_PRESETS = {
  normal: { fps: 10, scale: 480 },
  small:  { fps: 8,  scale: 320 },
} as const;
type GifQuality = keyof typeof GIF_PRESETS;

// ---------------------------------------------------------------------------
// Disk cache under /tmp — zero RAM overhead, survives between requests.
// Files older than TTL are ignored (and lazily replaced on next request);
// a periodic sweep deletes aged files and orphaned .tmp leftovers.
// ---------------------------------------------------------------------------
const CACHE_DIR = '/tmp/gmanimato-dl-cache';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // sweep deletes finished files older than this
const FFMPEG_TIMEOUT_MS = 120 * 1000; // per ffmpeg run
const TMP_MAX_AGE_MS = 2 * FFMPEG_TIMEOUT_MS + 60 * 1000; // orphaned .tmp older than this
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Global (per-process) cap on simultaneous ffmpeg runs; extra requests queue, and once the
// queue is full they get 429 immediately.
const MAX_CONCURRENT_FFMPEG = 2;
const MAX_QUEUED_FFMPEG = 20;
const RETRY_AFTER_SECONDS = 30;

const cache = new DownloadCache({
  dir: CACHE_DIR,
  ttlMs: CACHE_TTL_MS,
  maxAgeMs: CACHE_MAX_AGE_MS,
  tmpMaxAgeMs: TMP_MAX_AGE_MS,
});
const limiter = new FfmpegLimiter(MAX_CONCURRENT_FFMPEG, MAX_QUEUED_FFMPEG, RETRY_AFTER_SECONDS);

// Ensure cache directory exists once at module load time, then start the sweeper.
cache.ensureDir().then(() => cache.startSweeper(SWEEP_INTERVAL_MS));

function cacheFilePath(id: string, format: Format, fps: number, scale: number): string {
  return cache.filePath(id, format, fps, scale);
}

// In-flight deduplication: two simultaneous requests for the same key share
// one ffmpeg process. Only a Promise is held in memory, not the output data.
const inFlight = new Map<string, Promise<string>>();

// ---------------------------------------------------------------------------

function resolveVideoUrl(url: string): string {
  if (url.startsWith('/media/')) {
    const s3Endpoint = env.S3_ENDPOINT;
    if (!s3Endpoint) throw new Error('S3_ENDPOINT not configured');
    const path = url.slice('/media/'.length);
    return `${s3Endpoint}/${path}`;
  }
  return url;
}

/** Run ffmpeg, writing output directly to a temp file then atomically renaming it. */
async function convertWithFfmpeg(
  inputUrl: string,
  format: Format,
  fps: number,
  scale: number,
  outPath: string,
): Promise<void> {
  const tmpPath = `${outPath}.tmp`;
  const scaleFilter = `fps=${fps},scale=${scale}:-1:flags=lanczos`;

  let args: string[];
  if (format === 'gif') {
    args = [
      '-i', inputUrl,
      '-vf', `${scaleFilter},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      '-loop', '0',
      '-f', 'gif',
      '-y', tmpPath,
    ];
  } else {
    args = [
      '-i', inputUrl,
      '-vf', scaleFilter,
      '-loop', '0',
      '-f', 'webp',
      '-y', tmpPath,
    ];
  }

  // Hold the slot only while ffmpeg runs; the timer starts once the slot is acquired.
  await limiter.run(() => runFfmpeg(['-nostdin', ...args], tmpPath, { timeoutMs: FFMPEG_TIMEOUT_MS }));

  // Atomic rename so a partial file is never served
  await fs.rename(tmpPath, outPath);
}

/** Convert, using disk cache + in-flight deduplication. Returns cache file path. */
async function getConverted(
  inputUrl: string,
  videoId: string,
  format: Format,
  fps: number,
  scale: number,
): Promise<string> {
  const outPath = cacheFilePath(videoId, format, fps, scale);

  const cached = await cache.fresh(outPath);
  if (cached) return cached;

  // Deduplicate simultaneous identical requests
  const existing = inFlight.get(outPath);
  if (existing) return existing;

  // Lease covers the whole conversion (queue wait included) so the sweeper never removes
  // the .tmp file or a just-renamed result underneath us.
  const release = cache.hold(outPath);
  const promise = convertWithFfmpeg(inputUrl, format, fps, scale, outPath)
    .then(() => {
      inFlight.delete(outPath);
      return outPath;
    })
    .catch((err) => {
      inFlight.delete(outPath);
      throw err;
    })
    .finally(release);

  inFlight.set(outPath, promise);
  return promise;
}

function jsonError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const id = params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: 'Missing video id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const format = url.searchParams.get('format') as Format | null;
  if (!format || !ALLOWED_FORMATS.includes(format)) {
    return new Response(JSON.stringify({ error: `format must be one of: ${ALLOWED_FORMATS.join(', ')}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // quality=small only applies to GIF (320px / 8fps, targets <5 MB)
  const qualityParam = url.searchParams.get('quality');
  const gifQuality: GifQuality =
    format === 'gif' && qualityParam === 'small' ? 'small' : 'normal';

  const defaultFps   = format === 'gif' ? GIF_PRESETS[gifQuality].fps   : 10;
  const defaultScale = format === 'gif' ? GIF_PRESETS[gifQuality].scale : 480;

  const fpsRes = parseFps(url.searchParams.get('fps'), defaultFps);
  if (!fpsRes.ok) return jsonError(400, fpsRes.error);
  const scaleRes = parseScale(url.searchParams.get('scale'), defaultScale);
  if (!scaleRes.ok) return jsonError(400, scaleRes.error);
  const fps = fpsRes.value;
  const scale = scaleRes.value;

  const video = await getVideoById(id);
  if (!video) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isOwner = locals.user && video.user_id === locals.user.id;
  if (!isOwner && !video.is_published) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (video.status !== 'completed' || !video.final_video_url) {
    return new Response(JSON.stringify({ error: 'Video not ready' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let inputUrl: string;
  try {
    inputUrl = resolveVideoUrl(video.final_video_url);
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let filePath: string;
  try {
    filePath = await getConverted(inputUrl, id, format, fps, scale);
  } catch (err) {
    if (err instanceof FfmpegQueueFullError) {
      return jsonError(429, 'Too many conversions in progress, try again later', {
        'Retry-After': String(err.retryAfterSeconds),
      });
    }
    if (err instanceof FfmpegTimeoutError) {
      return jsonError(504, 'Conversion timed out');
    }
    const msg = String(err);
    const isNotFound = msg.includes('spawn') && msg.includes('ENOENT');
    return new Response(
      JSON.stringify({ error: isNotFound ? 'ffmpeg is not installed on this server' : msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Lease the file until the response stream ends so the sweeper cannot delete it mid-read.
  const releaseRead = cache.hold(filePath);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    releaseRead();
    return jsonError(500, String(err));
  }
  const mimeType = format === 'gif' ? 'image/gif' : 'image/webp';
  const qualitySuffix = format === 'gif' && gifQuality === 'small' ? '-small' : '';
  const filename = `video-${id}${qualitySuffix}.${format}`;

  // Stream the file — no buffering into RAM
  const nodeStream = createReadStream(filePath);
  nodeStream.once('close', releaseRead);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new Response(webStream, {
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
    },
  });
};
