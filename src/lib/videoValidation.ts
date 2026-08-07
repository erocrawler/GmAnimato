import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_REF_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB safety cap (client clips to ≤10s webm)
export const ALLOWED_VIDEO_TYPES = new Set(['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska']);
// Downscale ref videos so the long edge is at most 854px (~480p 16:9). Ref videos
// only condition the output (which is generated at 480p), so a smaller upload is
// faster to upload and cheaper for the worker to decode (VHS_LoadVideo).
export const MAX_VIDEO_LONG_EDGE = 854;

export interface VideoProcessResult {
  buffer: Buffer;
  ext: string;
  wasConverted: boolean;
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

/** Run ffmpeg to downscale a video buffer to MAX_VIDEO_LONG_EDGE (aspect-preserving, even dims),
 *  re-encoding to h264+aac mp4. Audio is preserved (the ref2v workflow uses the ref video's
 *  soundtrack via ref_video_audios). Returns the new buffer + 'mp4' ext. */
async function resizeVideoWithFfmpeg(buffer: Buffer, inputExt: string): Promise<{ buffer: Buffer; ext: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref2v-'));
  const inPath = path.join(tmpDir, `input.${inputExt}`);
  const outPath = path.join(tmpDir, 'output.mp4');
  try {
    await fs.writeFile(inPath, buffer);

    // Cap the long edge at MAX_VIDEO_LONG_EDGE (landscape -> width, portrait -> height),
    // preserve aspect ratio via -2 (even dimensions), never upscale (min()).
    const scaleFilter = `scale='if(gt(iw,ih),min(${MAX_VIDEO_LONG_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_VIDEO_LONG_EDGE},ih))'`;
    const args = [
      '-y',
      '-i', inPath,
      '-vf', scaleFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-map', '0:v:0',
      '-map', '0:a:0?',
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
    return { buffer: out, ext: 'mp4' };
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

  try {
    const resized = await resizeVideoWithFfmpeg(buffer, ext);
    // Only treat as "converted" if the output is actually smaller/valid.
    if (resized.buffer.length > 0 && resized.buffer.length < buffer.length) {
      return { buffer: resized.buffer, ext: resized.ext, wasConverted: true };
    }
    return { buffer, ext, wasConverted: false };
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
export async function extractVideoPoster(url: string, atSeconds = 0): Promise<Buffer | null> {
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
