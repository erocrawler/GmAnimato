import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById } from '$lib/db';
import { env } from '$env/dynamic/private';
import { spawn } from 'child_process';
import { createReadStream, promises as fs } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';

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
// Files older than TTL are ignored (and lazily replaced on next request).
// ---------------------------------------------------------------------------
const CACHE_DIR = '/tmp/gmanimato-dl-cache';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Ensure cache directory exists once at module load time.
fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {/* ignore */});

function cacheFilePath(id: string, format: Format, fps: number, scale: number): string {
  // Use only safe characters in the filename
  return join(CACHE_DIR, `${id}_${format}_${fps}_${scale}`);
}

async function getCachePath(path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return path;
  } catch {
    return null;
  }
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

  await new Promise<void>((resolve, reject) => {
    const errChunks: Buffer[] = [];
    const proc = spawn('ffmpeg', args);
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        fs.unlink(tmpPath).catch(() => {/* ignore */});
        const stderr = Buffer.concat(errChunks).toString();
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    proc.on('error', (err) => {
      fs.unlink(tmpPath).catch(() => {/* ignore */});
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });

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

  const cached = await getCachePath(outPath);
  if (cached) return cached;

  // Deduplicate simultaneous identical requests
  const existing = inFlight.get(outPath);
  if (existing) return existing;

  const promise = convertWithFfmpeg(inputUrl, format, fps, scale, outPath)
    .then(() => {
      inFlight.delete(outPath);
      return outPath;
    })
    .catch((err) => {
      inFlight.delete(outPath);
      throw err;
    });

  inFlight.set(outPath, promise);
  return promise;
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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

  const fpsParam   = url.searchParams.get('fps');
  const scaleParam = url.searchParams.get('scale');
  const fps   = Math.min(30, Math.max(1,   parseInt(fpsParam   ?? String(defaultFps),   10) || defaultFps));
  const scale = Math.min(1280, Math.max(120, parseInt(scaleParam ?? String(defaultScale), 10) || defaultScale));

  const video = await getVideoById(id);
  if (!video) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (video.user_id !== locals.user.id) {
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
    const msg = String(err);
    const isNotFound = msg.includes('spawn') && msg.includes('ENOENT');
    return new Response(
      JSON.stringify({ error: isNotFound ? 'ffmpeg is not installed on this server' : msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stat = await fs.stat(filePath);
  const mimeType = format === 'gif' ? 'image/gif' : 'image/webp';
  const qualitySuffix = format === 'gif' && gifQuality === 'small' ? '-small' : '';
  const filename = `video-${id}${qualitySuffix}.${format}`;

  // Stream the file — no buffering into RAM
  const nodeStream = createReadStream(filePath);
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
