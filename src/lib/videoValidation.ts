import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_REF_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB safety cap (client clips to ≤10s webm)
// Ref2V clip cap. The client clips the ref video to ≤10s before uploading;
// anything longer must be rejected (server-side), never silently accepted.
export const MAX_REF_VIDEO_SECONDS = 10;
export const ALLOWED_VIDEO_TYPES = new Set(['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska']);
// Downscale ref videos so the long edge is at most 854px (~480p 16:9). Ref videos
// only condition the output (which is generated at 480p), so a smaller upload is
// faster to upload and cheaper for the worker to decode (VHS_LoadVideo).
export const MAX_VIDEO_LONG_EDGE = 854;

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
  if (base === 'video/x-matroska') return 'mkv';
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

/** Run ffmpeg to downscale a video buffer to MAX_VIDEO_LONG_EDGE (aspect-preserving, even dims),
 *  re-encoding to h264+aac mp4. Audio is preserved when present (the ref2v workflow uses the ref video's
 *  soundtrack via ref_video_audios). Returns the new buffer + 'mp4' ext and whether audio is present. */
async function resizeVideoWithFfmpeg(buffer: Buffer, inputExt: string): Promise<{ buffer: Buffer; ext: string; hasAudio: boolean | null }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-'));
  const inPath = path.join(tmpDir, `input.${inputExt}`);
  const outPath = path.join(tmpDir, 'output.mp4');
  try {
    await fs.writeFile(inPath, buffer);

    // Cap the long edge at MAX_VIDEO_LONG_EDGE (landscape -> width, portrait -> height),
    // preserve aspect ratio via -2 (even dimensions), never upscale (min()).
    const scaleFilter = `scale='if(gt(iw,ih),min(${MAX_VIDEO_LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_VIDEO_LONG_EDGE},ih))'`;
    const hasAudio = await hasAudioStream(inPath);
    const args = [
      '-y',
      '-i', inPath,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      ...(hasAudio === false ? [] : ['-c:a', 'aac', '-b:a', '128k']),
      '-movflags', '+faststart',
      '-map', '0:v:0',
      ...(hasAudio === false ? [] : ['-map', '0:a:0?']),
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
    return { buffer: out, ext: 'mp4', hasAudio: outHasAudio ?? hasAudio ?? false };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Validates a reference video buffer and downscales it if needed.
 * - Checks type + size
 * - Re-encodes with ffmpeg to cap the long edge at ~480p (best-effort: on any
 *   ffmpeg failure the original is kept so the upload flow is never blocked).
 * Returns { buffer, ext, wasConverted, error }.
 */
export async function validateAndConvertVideo(buffer: Buffer, mime: string): Promise<VideoProcessResult> {
  if (!isAllowedVideoType(mime)) {
    return { buffer, ext: '', wasConverted: false, error: 'ref video must be webm, mp4, mov or mkv' };
  }
  if (buffer.length > MAX_REF_VIDEO_BYTES) {
    return { buffer, ext: '', wasConverted: false, error: `ref video too large (max ${Math.round(MAX_REF_VIDEO_BYTES / 1024 / 1024)} MB)` };
  }
  const ext = videoExtFromMime(mime);

  // Reject videos longer than the ref2v clip cap. The client clips to ≤10s
  // before uploading, but guard any path that bypasses that — a longer ref
  // would condition the job on far more footage than the UI intended. A small
  // grace (0.5s) absorbs ffprobe/MediaRecorder duration jitter on ~10s clips.
  const duration = await probeVideoDurationFromBuffer(buffer, ext);
  if (duration !== null && duration > MAX_REF_VIDEO_SECONDS + 0.5) {
    return {
      buffer,
      ext: '',
      wasConverted: false,
      error: `ref video is ${Math.round(duration)}s — max ${MAX_REF_VIDEO_SECONDS}s`,
    };
  }

  try {
    const resized = await resizeVideoWithFfmpeg(buffer, ext);
    // Only treat as "converted" if the output is actually smaller/valid.
    if (resized.buffer.length > 0 && resized.buffer.length < buffer.length) {
      return { buffer: resized.buffer, ext: resized.ext, wasConverted: true, hasAudio: resized.hasAudio ?? undefined };
    }
    // Even when we keep the original buffer (not smaller), expose hasAudio if we could probe it.
    return { buffer, ext, wasConverted: false, hasAudio: resized.hasAudio ?? undefined };
  } catch (e) {
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
