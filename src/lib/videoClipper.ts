/**
 * Client-side reference video utilities for Ref2V (MiniMax H3).
 *
 * - `clipVideoToWebm`: clips a source video (File or URL) to a webm/mp4 Blob using
 *   `<video>` + `canvas.captureStream()` + `MediaRecorder`. No server transcode.
 *   Includes fast-path: when no trim is needed (whole file ≤ max), return original bytes.
 * - `extractPosterFrame`: grabs a frame as PNG Blob for entry thumbnail.
 *
 * Notes:
 * - Source must be same-origin or CORS-enabled, otherwise canvas tainted.
 *   The site's `/media/...` proxy is same-origin, so reused videos work.
 * - MP4 is preferred: Chromium's MediaRecorder writes proper moov/duration for mp4,
 *   while its webm muxer produces files Chromium's own demuxer can't open
 *   (DEMUXER_ERROR_COULD_NOT_OPEN — missing cues). That explains after-clipping preview breakage.
 * - MIME base stripped from codecs param to avoid demuxer confusion.
 * - Audio track merging respects includeAudio flag.
 */

// MP4-first: Chromium's MP4 muxer produces playable blobs, webm muxer often not.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser');
  }
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

/** Strip codec params so blob/File Content-Type stays clean. */
function baseMimeType(mime: string): string {
  const base = (mime || '').split(';')[0].trim();
  return base || 'video/mp4';
}

function loadVideoElement(source: File | string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const src = typeof source === 'string' ? source : objectUrl!;

    const cleanup = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
    };

    const onError = () => {
      cleanup();
      reject(new Error('Failed to load video source'));
    };

    video.onloadedmetadata = () => {
      video.ontimeupdate = null;
      video.onerror = null;
      // Keep objectUrl alive — caller uses same element for captureStream
      resolve(video);
    };
    video.onerror = onError;
    video.src = src;
  });
}

export interface ClipResult {
  blob: Blob;
  mimeType: string;
}

function isFullClip(startSec: number, endSec: number, duration: number): boolean {
  const eps = 0.15;
  return startSec <= eps && endSec + eps >= duration;
}

/**
 * Clip [startSec, endSec] into mp4/webm Blob.
 * Fast-path: whole file ≤ maxDuration → return original bytes (no re-encode).
 * includeAudio controls whether audio track is merged.
 */
export async function clipVideoToWebm(
  source: File | string,
  startSec: number,
  endSec: number,
  maxDurationSec = 10,
  includeAudio = true,
): Promise<ClipResult> {
  // Fast-path: original File, no trim needed
  if (source instanceof File) {
    try {
      const probeDur = await getVideoDuration(source);
      const safeStart = Math.max(0, Math.min(startSec, probeDur));
      const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));
      if (isFullClip(safeStart, safeEnd, probeDur) && probeDur <= maxDurationSec + 0.05) {
        return { blob: source, mimeType: source.type || 'video/mp4' };
      }
    } catch {
      // probe failed -> fall through
    }
  } else if (typeof source === 'string') {
    try {
      const v = await loadVideoElement(source);
      const dur = v.duration;
      v.removeAttribute('src');
      v.load();
      const safeStart = Math.max(0, Math.min(startSec, dur));
      const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));
      if (isFullClip(safeStart, safeEnd, dur) && dur <= maxDurationSec + 0.05) {
        const res = await fetch(source);
        if (res.ok) {
          const blob = await res.blob();
          return { blob, mimeType: blob.type || 'video/mp4' };
        }
      }
    } catch {
      // fall through
    }
  }

  const video = await loadVideoElement(source);
  try {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Invalid video duration');
    }

    const safeStart = Math.max(0, Math.min(startSec, duration));
    const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));

    if (isFullClip(safeStart, safeEnd, duration) && duration <= maxDurationSec + 0.05 && source instanceof File) {
      return { blob: source, mimeType: source.type || 'video/mp4' };
    }

    const width = Math.max(2, Math.floor(video.videoWidth / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    const stream = canvas.captureStream(24);
    if (includeAudio) {
      try {
        const srcStream = (video as any).captureStream?.() || (video as any).mozCaptureStream?.();
        if (srcStream) {
          for (const track of srcStream.getAudioTracks()) {
            stream.addTrack(track);
          }
        }
      } catch {
        // ignore — no audio track or captureStream not supported
      }
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 4_000_000,
      ...(includeAudio && stream.getAudioTracks().length > 0 ? { audioBitsPerSecond: 128_000 } : {}),
    });

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (e) => reject(e as unknown as Error);
    });

    const drawFrame = () => {
      ctx.drawImage(video, 0, 0, width, height);
    };

    return new Promise((resolve, reject) => {
      let recorderStarted = false;
      let finished = false;
      let rvcbId = 0;

      const finish = (err?: unknown) => {
        if (finished) return;
        finished = true;
        if (rvcbId && (video as any).cancelVideoFrameCallback) {
          try { (video as any).cancelVideoFrameCallback(rvcbId); } catch {}
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (err) {
          reject(err);
        } else {
          const cleanMime = baseMimeType(mimeType);
          const blob = new Blob(chunks, { type: cleanMime });
          resolve({ blob, mimeType: cleanMime });
        }
      };

      const hangTimeout = window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* ignore */ }
        } else {
          onStop();
        }
      }, (safeEnd - safeStart + 5) * 1000);

      const onStop = () => {
        window.clearTimeout(hangTimeout);
        finish();
      };
      stopped.then(onStop).catch((err) => finish(err));

      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.play().catch(() => {});
      };

      // Use requestVideoFrameCallback for frame-accurate stop (falls back to
      // requestAnimationFrame). setInterval(50) had ±50ms jitter causing 10.1s
      // clips instead of exact 10.0s.
      const hasRVFC = typeof (video as any).requestVideoFrameCallback === 'function';
      const checkStop = () => {
        if (finished) return;
        if (video.currentTime >= safeEnd) {
          if (recorder.state !== 'inactive') recorder.stop();
          else onStop();
          return;
        }
        drawFrame();
        if (hasRVFC) {
          rvcbId = (video as any).requestVideoFrameCallback(checkStop);
        } else {
          requestAnimationFrame(checkStop);
        }
      };

      if (video.currentTime >= safeStart && !recorderStarted) {
        recorderStarted = true;
        recorder.start(200);
        drawFrame();
        checkStop(); // start the frame-accurate stop loop
      }

      video.addEventListener('seeked', onSeeked);
      video.ontimeupdate = () => {
        if (video.currentTime >= safeStart && !recorderStarted) {
          recorderStarted = true;
          recorder.start(200);
          drawFrame();
          checkStop(); // start the frame-accurate stop loop
        }
      };

      if (Math.abs(video.currentTime - safeStart) > 0.01) {
        video.currentTime = safeStart;
      } else {
        onSeeked();
      }
    });
  } catch (err) {
    video.removeAttribute('src');
    video.load();
    throw err;
  }
}

export async function extractPosterFrame(source: File | string, atSec = 0): Promise<Blob> {
  const video = await loadVideoElement(source);
  try {
    const width = Math.max(2, Math.floor(video.videoWidth / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    // Nudge away from 0 to avoid black first-frame on some encoders
    const safeAt = Math.min(
      Math.max(0.05, atSec || 0.1),
      Math.max(0, (video.duration || 1) - 0.05)
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('seek timeout')), 5000);
      const onSeeked = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        reject(new Error('seek failed'));
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      if (Math.abs(video.currentTime - safeAt) < 0.01) {
        // Already at target — still need seeked to fire for some browsers, so nudge
        video.currentTime = safeAt + 0.001;
      } else {
        video.currentTime = safeAt;
      }
    });

    // Wait for frame to be actually renderable — seeked fires before decode in Chrome
    if (typeof (video as any).requestVideoFrameCallback === 'function') {
      await new Promise<void>((resolve) => {
        (video as any).requestVideoFrameCallback(() => resolve());
      });
    } else {
      // Double rAF to ensure paint
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }

    // Extra pause to let decoder fill current frame
    if (video.readyState < 2) {
      await new Promise<void>((r) => {
        const onCanPlay = () => {
          video.removeEventListener('canplay', onCanPlay);
          r();
        };
        video.addEventListener('canplay', onCanPlay);
        setTimeout(r, 200);
      });
    }

    ctx.drawImage(video, 0, 0, width, height);

    // Heuristic: detect empty black frame (first bytes often all zero on failure)
    // If all pixels transparent/black, retry at slightly later time
    try {
      const imgData = ctx.getImageData(0, 0, Math.min(16, width), Math.min(16, height));
      const isBlank = imgData.data.every((v, i) => (i % 4 === 3 ? true : v < 8));
      if (isBlank && safeAt < (video.duration || 10) - 0.5) {
        const retryAt = Math.min(safeAt + 0.3, (video.duration || 10) - 0.1);
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked);
          video.currentTime = retryAt;
        });
        if (typeof (video as any).requestVideoFrameCallback === 'function') {
          await new Promise<void>((resolve) => {
            (video as any).requestVideoFrameCallback(() => resolve());
          });
        } else {
          await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        }
        ctx.drawImage(video, 0, 0, width, height);
      }
    } catch {
      // getImageData can throw if canvas tainted (cross-origin) — ignore and keep first draw
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to extract poster frame');
    if (blob.size < 500) {
      console.warn('[Poster] Suspiciously small poster blob', blob.size);
    }
    return blob;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export function getVideoDuration(source: File | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const url = typeof source === 'string' ? source : objectUrl!;

    video.onloadedmetadata = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(video.duration);
    };
    video.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to read video metadata'));
    };
    video.src = url;
  });
}
