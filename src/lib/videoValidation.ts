import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_DURATION_SECONDS_FREE } from './mediaLimits';
import {
  ALLOWED_VIDEO_TYPES,
  MAX_REF_VIDEO_BYTES,
  MAX_REF_VIDEO_FPS,
  MAX_VIDEO_LONG_EDGE,
  MIN_REF_VIDEO_FRAMES,
} from './mediaLimits';

// --- Reference audio (ref2v standalone <Audio 1>) --------------------------
// A single standalone ref audio conditions the generated soundtrack. It is
// clipped/normalized to ≤15s; anything longer is rejected (client + server).
export const MAX_REF_AUDIO_SECONDS = 15;
export const MAX_REF_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB safety cap
export const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', // mp3
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/aac',
  'audio/mp4', // m4a
  'audio/x-m4a',
  'audio/flac',
]);

export interface VideoProcessResult {
  buffer: Buffer;
  ext: string;
  wasConverted: boolean;
  hasAudio?: boolean;
  error?: string;
}

// MediaRecorder mime types include codec params (e.g. 'video/webm;codecs=vp9,opus');
// compare only the base type (before ';').
export function isAllowedVideoType(mime: string): boolean {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_VIDEO_TYPES.has(base);
}

export function videoExtFromMime(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  if (base === 'video/webm') return 'webm';
  if (base === 'video/mp4') return 'mp4';
  if (base === 'video/quicktime') return 'mov';
  if (base === 'video/x-matroska' || base === 'video/matroska') return 'mkv';
  return 'webm';
}

/** Probe whether a container has an audio stream (best-effort via ffprobe). */
export async function hasAudioStream(inPath: string): Promise<boolean | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=index',
        '-of', 'csv=p=0',
        inPath,
      ]);
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.on('close', () => resolve(Buffer.concat(chunks).toString()));
      proc.on('error', reject);
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

/** Lightweight hasAudio probe from an in-memory buffer (no tmp file, no ffmpeg). */
export async function hasAudioFromBuffer(buffer: Buffer): Promise<boolean | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=index',
        '-of', 'csv=p=0',
        'pipe:0',
      ]);
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.on('close', () => resolve(Buffer.concat(chunks).toString()));
      proc.on('error', reject);
      proc.stdin.on('error', () => {});
      proc.stdin.write(buffer);
      proc.stdin.end();
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

/** Options for server-side video clipping (used when the client's browser
 *  can't decode the container, e.g. MKV in Chromium — no Matroska demuxer). */
export interface VideoTrimOptions {
  startSec?: number;
  endSec?: number;
  includeAudio?: boolean;
}

/** Run ffmpeg to downscale a video buffer to MAX_VIDEO_LONG_EDGE (aspect-preserving, even dims)
 *  and cap its frame rate at MAX_REF_VIDEO_FPS, re-encoding to h264+aac mp4. Audio is preserved
 *  when present (the ref2v workflow uses the ref video's soundtrack via ref_video_audios). When
 *  `opts.startSec`/`opts.endSec` are set the input is trimmed (accurate seek — decode from the
 *  nearest keyframe, so the window is precise at the cost of decoding up to `startSec` of source).
 *  Returns the new buffer + 'mp4' ext, whether audio is present, the frame count of the OUTPUT
 *  (the video the model will actually receive), and whether the source frame rate exceeded the cap. */
async function resizeVideoWithFfmpeg(
  buffer: Buffer,
  inputExt: string,
  opts: VideoTrimOptions = {},
): Promise<{
  buffer: Buffer;
  ext: string;
  hasAudio: boolean | null;
  frames: number | null;
  fpsCapped: boolean;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-'));
  const inPath = path.join(tmpDir, `input.${inputExt}`);
  const outPath = path.join(tmpDir, 'output.mp4');
  try {
    await fs.writeFile(inPath, buffer);

    // Cap the long edge at MAX_VIDEO_LONG_EDGE (landscape -> width, portrait -> height),
    // preserve aspect ratio via -2 (even dimensions), never upscale (min()).
    const scaleFilter = `scale='if(gt(iw,ih),min(${MAX_VIDEO_LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_VIDEO_LONG_EDGE},ih))'`;
    // Cap the frame rate at the model's rate. min() means downsample only —
    // a 12fps source stays 12fps rather than being padded up to 24. This keeps
    // the uploaded frame count equal to what VHS_LoadVideo's force_rate yields,
    // so the frame guard on the output is exact.
    const fpsFilter = `fps='min(source_fps,${MAX_REF_VIDEO_FPS})'`;
    const vfFilter = `${scaleFilter},${fpsFilter}`;
    const startSec =
      opts.startSec !== undefined && Number.isFinite(opts.startSec) ? Math.max(0, opts.startSec) : 0;
    const endSec =
      opts.endSec !== undefined && Number.isFinite(opts.endSec) ? Math.max(startSec, opts.endSec) : undefined;
    const hasAudio = opts.includeAudio === false ? false : await hasAudioStream(inPath);
    // Trim args are placed AFTER `-i` (output options) for an accurate seek:
    // the output runs exactly from startSec to endSec. Fast seeking (before
    // -i) would land on the nearest keyframe and shift the window by up to a
    // GOP, which matters when the user picked a specific scene to condition on.
    const trimArgs: string[] = [];
    if (startSec > 0) trimArgs.push('-ss', String(startSec));
    if (endSec !== undefined) trimArgs.push('-to', String(endSec));
    const mapAudio = hasAudio !== false;
    const args = [
      '-y',
      '-i', inPath,
      ...trimArgs,
      '-vf', vfFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      ...(mapAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
      '-movflags', '+faststart',
      '-map', '0:v:0',
      ...(mapAudio ? ['-map', '0:a:0?'] : []),
      ...(opts.includeAudio === false ? ['-an'] : []),
      outPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      const proc = spawn('ffmpeg', args);
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString().slice(-500)}`));
      });
      proc.on('error', (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
    });

    const out = await fs.readFile(outPath);
    // Re-probe output when input had unknown audio presence to get accurate hasAudio.
    let outHasAudio = hasAudio;
    if (hasAudio === null) outHasAudio = await hasAudioStream(outPath);
    // Frame count of the actual output — this IS the video the ref2v model
    // conditions on (trimming included). The mp4 muxer writes nb_frames, so
    // this reads container metadata: immediate, no decode.
    const frames = await probeVideoFrameCount(outPath);
    // Was the source faster than the model's rate? Callers use this to force
    // the re-encoded output through even when it isn't smaller: keeping the
    // original would upload the uncapped frame rate.
    const inFps = await probeVideoFrameRate(inPath);
    const fpsCapped = inFps !== null && inFps > MAX_REF_VIDEO_FPS + 0.01;
    return { buffer: out, ext: 'mp4', hasAudio: outHasAudio ?? hasAudio ?? false, frames, fpsCapped };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Validates a reference video buffer and downscales it if needed.
 * - Checks type + size
 * - Rejects videos longer than `maxSeconds` (default: the free-tier max
 *   allowed duration; callers pass their tier cap — 6s free / 15s paid)
 * - Re-encodes with ffmpeg to cap the long edge at ~480p. On ffmpeg failure
 *   the original is kept so the upload flow is never blocked — EXCEPT when a
 *   trim window (`opts.startSec`/`opts.endSec`) was explicitly requested
 *   (browser-undecodable containers, or a failed client clip falling back to
 *   server trim): then a failure is a hard error, since falling back to the
 *   original would upload an untrimmed/undecodable file and produce a broken
 *   entry.
 * Returns { buffer, ext, wasConverted, error }.
 */
export async function validateAndConvertVideo(
  buffer: Buffer,
  mime: string,
  maxSeconds: number = MAX_DURATION_SECONDS_FREE,
  opts: VideoTrimOptions = {},
): Promise<VideoProcessResult> {
  if (!isAllowedVideoType(mime)) {
    return { buffer, ext: '', wasConverted: false, error: 'ref video must be webm, mp4, mov or mkv' };
  }
  if (buffer.length > MAX_REF_VIDEO_BYTES) {
    return { buffer, ext: '', wasConverted: false, error: `ref video too large (max ${Math.round(MAX_REF_VIDEO_BYTES / 1024 / 1024)} MB)` };
  }
  const ext = videoExtFromMime(mime);

  // The trim window (when one is requested) is what actually reaches the model,
  // so both the length and the frame-count guards are evaluated against it.
  const startSec =
    opts.startSec !== undefined && Number.isFinite(opts.startSec) ? Math.max(0, opts.startSec) : 0;
  const duration = await probeVideoDurationFromBuffer(buffer, ext);
  // Window end: the requested end clamped to the source length (unknown length
  // -> the requested end as-is, or null when no window was requested).
  const endSec: number | null =
    opts.endSec !== undefined && Number.isFinite(opts.endSec)
      ? duration !== null
        ? Math.min(opts.endSec, duration)
        : opts.endSec
      : duration;

  // Reject videos longer than the caller's ref2v clip cap (tier-based: free
  // 6s, paid 15s). The client clips before uploading, but guard any path that
  // bypasses that — a longer ref would condition the job on far more footage
  // than the UI intended. A small grace (0.5s) absorbs ffprobe/MediaRecorder
  // duration jitter on clips at the cap. When a server-side trim window is
  // provided (browser-unsupported containers like MKV), the EFFECTIVE trimmed
  // duration is what matters.
  if (duration !== null) {
    const effective = Math.max(0, (endSec ?? duration) - startSec);
    if (effective > maxSeconds + 0.5) {
      return {
        buffer,
        ext: '',
        wasConverted: false,
        error: `ref video is ${Math.round(effective)}s — max ${maxSeconds}s`,
      };
    }
  }

  // Frame-count guard (pre-encode; needs only ffprobe): the model conditions on
  // the ref video's decoded frame batch, so a clip carrying a handful of frames
  // is unusable and fails the worker job. Rejecting here gives an immediate,
  // actionable error instead of a later "workflow failed".
  const framesError = await checkMinFramesFromBuffer(buffer, ext, startSec, endSec, duration);
  if (framesError) {
    return { buffer, ext: '', wasConverted: false, error: framesError };
  }

  try {
    const resized = await resizeVideoWithFfmpeg(buffer, ext, opts);
    // Authoritative frame check on the converted output: it IS the video the
    // model receives, so this catches a window that only looked long enough
    // when estimated, and any ffmpeg truncation.
    if (resized.frames !== null && resized.frames < MIN_REF_VIDEO_FRAMES) {
      return { buffer, ext: '', wasConverted: false, error: minFramesMessage(resized.frames) };
    }
    // Re-encoding is mandatory when audio must be dropped (the only way audio
    // is stripped), when a trim was requested, or when the source ran faster
    // than the model's rate (the only way the fps cap is applied) — whenever
    // the output isn't smaller than the input, keeping the original would
    // upload untrimmed / uncapped footage.
    const trims = startSec > 0.01 || (duration !== null && endSec !== null && endSec < duration - 0.05);
    const forceConvert = opts.includeAudio === false || trims || resized.fpsCapped;
    // Only treat as "converted" if the output is actually smaller/valid.
    if (resized.buffer.length > 0 && (forceConvert || resized.buffer.length < buffer.length)) {
      return { buffer: resized.buffer, ext: resized.ext, wasConverted: true, hasAudio: resized.hasAudio ?? undefined };
    }
    // Even when we keep the original buffer (not smaller), expose hasAudio if we could probe it.
    return { buffer, ext, wasConverted: false, hasAudio: resized.hasAudio ?? undefined };
  } catch (e) {
    // A trim window was explicitly requested (browser-undecodable container
    // like MKV, or a client clip that failed and fell back to server trim) —
    // the whole point is to re-encode a specific window. Falling back to the
    // original would upload an untrimmed (or undecodable) file and produce a
    // broken entry, so surface a hard error instead.
    const needsTrim = opts.startSec !== undefined || opts.endSec !== undefined;
    if (needsTrim) {
      console.error('[Video] Ref video trim/resize failed:', e);
      return {
        buffer,
        ext: '',
        wasConverted: false,
        error: `Failed to process the reference video: ${(e as Error)?.message || String(e)}`,
      };
    }
    console.warn('[Video] Ref video resize failed, using original:', e);
    return { buffer, ext, wasConverted: false };
  }
}

/**
 * Grab a poster frame (PNG) from a video URL using ffmpeg.
 * Used as the entry thumbnail (original_image_url) when a ref video URL is
 * provided instead of an uploaded file (client can't extract a frame from a
 * cross-origin URL). Best-effort: returns null on any failure.
 */
export async function extractVideoPoster(url: string, atSeconds = 0.1): Promise<Buffer | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-poster-'));
  const outPath = path.join(tmpDir, 'poster.png');
  try {
    const args = [
      '-y',
      '-ss', String(atSeconds),
      '-i', url,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-f', 'image2',
      outPath,
    ];
    await new Promise<void>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      const proc = spawn('ffmpeg', args);
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString().slice(-400)}`));
      });
      proc.on('error', (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
    });
    const out = await fs.readFile(outPath);
    return out.length > 0 ? out : null;
  } catch (e) {
    console.warn('[Video] Poster extraction failed for', url, e);
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Probe a video's duration (seconds) with ffprobe. Returns null on failure. */
export async function probeVideoDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      url,
    ]);
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('close', (code) => {
      const dur = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(dur) && dur > 0 ? dur : null);
    });
    proc.on('error', () => resolve(null));
  });
}

/** Probe a video's display dimensions (width/height) with ffprobe.
 *  Returns null on failure. Uses ffprobe directly, so it works for mp4/webm
 *  containers that probe-image-size cannot read. */
export async function probeVideoDimensions(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      url,
    ]);
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('close', (code) => {
      const parts = out.trim().split(',');
      const width = Number.parseInt(parts[0], 10);
      const height = Number.parseInt(parts[1], 10);
      resolve(
        code === 0 && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
          ? { width, height }
          : null
      );
    });
    proc.on('error', () => resolve(null));
  });
}

/** Probe a video buffer's duration by writing it to a temp file and ffprobing. */
async function probeVideoDurationFromBuffer(buffer: Buffer, ext: string): Promise<number | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-probe-'));
  const inPath = path.join(tmpDir, `probe.${ext || 'mp4'}`);
  try {
    await fs.writeFile(inPath, buffer);
    return await probeVideoDuration(inPath);
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run ffprobe with the given args and return the parsed JSON stdout, or null
 *  when ffprobe is missing, exits non-zero, or emits unparseable output. */
async function ffprobeJson(args: string[]): Promise<any | null> {
  const out = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn('ffprobe', args);
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString() : null));
    proc.on('error', () => resolve(null));
  });
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Parse an ffprobe rational frame rate such as '24/1' or '30000/1001'. */
function parseFrameRate(value: string): number | null {
  const [numRaw, denRaw] = value.split('/');
  const num = Number.parseFloat(numRaw);
  const den = denRaw === undefined ? 1 : Number.parseFloat(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  return num / den;
}

/**
 * Probe a video's frame count with ffprobe (accepts a path or a URL).
 *
 * Fast path (default): reads the container's `nb_frames` — authoritative for
 * mp4/mov — and otherwise derives duration x avg_frame_rate, which is exact by
 * definition when the container reports an average rate. Both are immediate:
 * no decoding.
 *
 * `accurate = true` decodes the stream and counts every frame
 * (`-count_frames`): slow, but authoritative for containers that report
 * nothing usable. Returns null when the count can't be determined.
 */
export async function probeVideoFrameCount(url: string, accurate = false): Promise<number | null> {
  if (!accurate) {
    const meta = await ffprobeJson([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames,avg_frame_rate:format=duration',
      '-of', 'json',
      url,
    ]);
    const stream = meta?.streams?.[0];
    if (stream) {
      const nbFrames = Number.parseInt(String(stream.nb_frames ?? ''), 10);
      if (Number.isFinite(nbFrames) && nbFrames > 0) return nbFrames;
      const fps = parseFrameRate(String(stream.avg_frame_rate ?? ''));
      const seconds = Number.parseFloat(String(meta?.format?.duration ?? ''));
      if (fps !== null && Number.isFinite(seconds) && seconds > 0) {
        const estimated = Math.round(fps * seconds);
        if (estimated > 0) return estimated;
      }
    }
  }

  const counted = await ffprobeJson([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'json',
    url,
  ]);
  const frames = Number.parseInt(String(counted?.streams?.[0]?.nb_read_frames ?? ''), 10);
  return Number.isFinite(frames) && frames > 0 ? frames : null;
}

/** Probe a video's average frame rate with ffprobe (accepts a path or a URL).
 *  Returns null when it can't be determined. */
export async function probeVideoFrameRate(url: string): Promise<number | null> {
  const meta = await ffprobeJson([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate',
    '-of', 'json',
    url,
  ]);
  const rate = parseFrameRate(String(meta?.streams?.[0]?.avg_frame_rate ?? ''));
  return rate !== null && rate > 0 ? rate : null;
}

/**
 * Frames the ref2v model will actually receive from a reference video.
 *
 * The worker's VHS_LoadVideo runs with `force_rate: MAX_REF_VIDEO_FPS`, so a
 * source faster than that rate is decimated: the model sees
 * `duration x MAX_REF_VIDEO_FPS` frames, NOT the container's own frame count.
 * Counting the container would wrongly accept a short high-fps clip that the
 * worker then decodes to fewer than MIN_REF_VIDEO_FRAMES frames. Sources at or
 * below the cap (and sources whose rate can't be read) are counted as-is.
 *
 * Best-effort: returns null when the count can't be determined.
 */
export async function probeModelFrameCount(url: string, accurate = false): Promise<number | null> {
  const frames = await probeVideoFrameCount(url, accurate);
  if (frames === null) return null;
  const fps = await probeVideoFrameRate(url);
  if (fps === null || fps <= MAX_REF_VIDEO_FPS + 0.01) return frames;
  const duration = await probeVideoDuration(url);
  if (duration === null || duration <= 0) return frames;
  return Math.max(1, Math.round(duration * MAX_REF_VIDEO_FPS));
}

/** Error message for a ref video that carries too few frames. */
function minFramesMessage(frames: number): string {
  return `ref video has only ${frames} frame${frames === 1 ? '' : 's'} — at least ${MIN_REF_VIDEO_FRAMES} are required. Please use a longer clip.`;
}

/**
 * Frame-count guard for a ref video buffer. Counts the frames the MODEL will
 * receive inside the EFFECTIVE trim window (the window is what actually reaches
 * the model, at the model's frame rate) and returns an error message when that
 * count is known to be under MIN_REF_VIDEO_FRAMES, otherwise null.
 *
 * Best-effort by design: an undeterminable count returns null so a valid
 * upload is never blocked by a failed probe.
 */
async function checkMinFramesFromBuffer(
  buffer: Buffer,
  ext: string,
  startSec: number,
  endSec: number | null,
  duration: number | null,
): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-frames-'));
  const inPath = path.join(tmpDir, `input.${ext || 'mp4'}`);
  try {
    await fs.writeFile(inPath, buffer);

    // Scale the source's frame count down to the trim window (a full-range
    // window is simply the source's own count).
    const inWindow = (total: number): number => {
      if (duration === null || duration <= 0) return total;
      const windowSec = Math.max(0, (endSec ?? duration) - startSec);
      if (windowSec >= duration - 0.01) return total;
      return Math.round(total * (windowSec / duration));
    };

    // probeModelFrameCount, not probeVideoFrameCount: a source faster than the
    // model's rate is decimated by VHS_LoadVideo's force_rate, so counting the
    // container alone would pass a short high-fps clip the worker then sees as
    // fewer than MIN_REF_VIDEO_FRAMES frames.
    let total = await probeModelFrameCount(inPath);
    if (total === null) total = await probeModelFrameCount(inPath, true);
    if (total === null) return null; // undeterminable -> don't block the upload
    if (inWindow(total) >= MIN_REF_VIDEO_FRAMES) return null;

    // Below the minimum on a cheap read — decode and count before rejecting a
    // valid upload (nb_frames/avg_frame_rate can be wrong on some containers).
    const accurate = await probeModelFrameCount(inPath, true);
    const confirmed = accurate ?? total;
    if (inWindow(confirmed) >= MIN_REF_VIDEO_FRAMES) return null;
    return minFramesMessage(inWindow(confirmed));
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract N evenly-spaced screenshot frames (JPEG) from a video URL using
 * ffmpeg. Used by the MiniMax H3 prompt enhancer so the vision model can see
 * what the reference video actually shows (subject appearance, motion, scene).
 * Best-effort: returns whatever frames could be extracted (possibly fewer than
 * requested, possibly none).
 */
export async function extractVideoScreenshots(
  url: string,
  count = 3,
): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-shots-'));
  try {
    // Sample at even intervals across the duration when known; otherwise use
    // fixed offsets (0, 1, 3s...). Skip the very last frame (could be black).
    const duration = await probeVideoDuration(url);
    const timestamps: number[] = [];
    if (duration && duration > 0.5) {
      const span = Math.max(0, duration - 0.25);
      for (let i = 0; i < count; i++) {
        timestamps.push(span * (i / Math.max(1, count - 1)));
      }
    } else {
      for (let i = 0; i < count; i++) timestamps.push(i);
    }

    for (let i = 0; i < timestamps.length; i++) {
      const outPath = path.join(tmpDir, `shot_${i}.jpg`);
      try {
        await new Promise<void>((resolve, reject) => {
          const errChunks: Buffer[] = [];
          const proc = spawn('ffmpeg', [
            '-y',
            '-ss', String(timestamps[i]),
            '-i', url,
            '-frames:v', '1',
            '-vf', 'scale=480:-2',
            '-f', 'image2',
            '-q:v', '4',
            outPath,
          ]);
          proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
          });
          proc.on('error', (err) => reject(err));
        });
        const buf = await fs.readFile(outPath);
        if (buf.length > 0) frames.push(buf);
      } catch (e) {
        console.warn(`[Video] Screenshot ${i} extraction failed:`, e);
      }
    }
    return frames;
  } catch (e) {
    console.warn('[Video] Screenshot extraction failed for', url, e);
    return frames;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Reference audio (ref2v standalone reference) ---------------------------

export function isAllowedAudioType(mime: string): boolean {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_AUDIO_TYPES.has(base);
}

export function audioExtFromMime(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/aac') return 'aac';
  if (base === 'audio/mp4' || base === 'audio/x-m4a') return 'm4a';
  if (base === 'audio/flac') return 'flac';
  return 'mp3';
}

/** Probe an audio buffer's duration (seconds) by writing it to a temp file
 *  and ffprobing it (same approach as the ref-video probe). */
async function probeAudioDurationFromBuffer(buffer: Buffer, ext: string): Promise<number | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-audio-probe-'));
  const inPath = path.join(tmpDir, `probe.${ext || 'mp3'}`);
  try {
    await fs.writeFile(inPath, buffer);
    return await probeVideoDuration(inPath); // ffprobe format=duration works for any media
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Best-effort ffmpeg transcode to PCM WAV — universally decodable by
 *  ComfyUI's core LoadAudio node regardless of torchaudio/soundfile backend.
 *  Returns null on any failure (caller keeps the original). */
async function convertAudioToWav(buffer: Buffer, inputExt: string): Promise<Buffer | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-audio-'));
  const inPath = path.join(tmpDir, `input.${inputExt}`);
  const outPath = path.join(tmpDir, 'output.wav');
  try {
    await fs.writeFile(inPath, buffer);
    await new Promise<void>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      const proc = spawn('ffmpeg', [
        '-y',
        '-i', inPath,
        '-vn',
        '-ac', '2',
        '-ar', '44100',
        '-c:a', 'pcm_s16le',
        outPath,
      ]);
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString().slice(-400)}`));
      });
      proc.on('error', (err) => reject(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
    });
    const out = await fs.readFile(outPath);
    return out.length > 0 ? out : null;
  } catch (e) {
    console.warn('[Audio] Ref audio transcode failed, keeping original:', e);
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface AudioProcessResult {
  buffer: Buffer;
  ext: string;
  wasConverted: boolean;
  error?: string;
}

/**
 * Validates a standalone reference audio buffer for ref2v:
 * - Checks type + size.
 * - Rejects audio longer than MAX_REF_AUDIO_SECONDS (never silently accept a
 *   clip longer than the intended conditioning window).
 * - Re-encodes to PCM WAV (best-effort) so ComfyUI's LoadAudio can read it.
 * Returns { buffer, ext, wasConverted, error }.
 */
export async function validateAndConvertReferenceAudio(buffer: Buffer, mime: string): Promise<AudioProcessResult> {
  if (!isAllowedAudioType(mime)) {
    return { buffer, ext: '', wasConverted: false, error: 'ref audio must be mp3, wav, ogg, m4a/aac or flac' };
  }
  if (buffer.length > MAX_REF_AUDIO_BYTES) {
    return { buffer, ext: '', wasConverted: false, error: `ref audio too large (max ${Math.round(MAX_REF_AUDIO_BYTES / 1024 / 1024)} MB)` };
  }
  const ext = audioExtFromMime(mime);

  // Reject audio longer than the ref2v audio cap. A small grace (0.5s) absorbs
  // ffprobe/HTMLAudioElement duration jitter on ~15s clips.
  const duration = await probeAudioDurationFromBuffer(buffer, ext);
  if (duration !== null && duration > MAX_REF_AUDIO_SECONDS + 0.5) {
    return {
      buffer,
      ext: '',
      wasConverted: false,
      error: `ref audio is ${Math.round(duration)}s — max ${MAX_REF_AUDIO_SECONDS}s`,
    };
  }

  const wav = await convertAudioToWav(buffer, ext);
  if (wav) {
    return { buffer: wav, ext: 'wav', wasConverted: true };
  }
  return { buffer, ext, wasConverted: false };
}
