/**
 * Client-side reference video utilities for Ref2V (MiniMax H3).
 *
 * - `clipVideoToWebm`: clips a source video (File or URL) to a webm Blob using
 *   `<video>` + `canvas.captureStream()` + `MediaRecorder` when trimming is
 *   required, otherwise skips re-encoding and returns the original Blob.
 * - `extractPosterFrame`: grabs a frame as a PNG Blob (used as the entry's
 *   `original_image_url` thumbnail, since ref2v may have no "first image").
 *
 * Notes:
 * - The source must be same-origin or CORS-enabled, otherwise the canvas is
 *   tainted and `captureStream`/`toBlob` fail. The site's `/media/...` proxy is
 *   same-origin, so reused videos work.
 * - WebM (VP8/Opus) is chosen because VHS `LoadVideo` (already installed in the
 *   worker) decodes it, and `uploadBufferToS3` supports the `video/webm` type.
 * - When trimming is required we use `requestVideoFrameCallback` (frame-aligned)
 *   with `requestAnimationFrame` fallback instead of `setInterval`, plus we
 *   merge the audio track so sound is preserved.
 */

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
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

function loadVideoElement(source: File | string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    const objectUrl =
      typeof source === 'string' ? null : URL.createObjectURL(source);
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

/** Whether the requested clip covers the whole file (within epsilon) */
function isFullClip(startSec: number, endSec: number, duration: number): boolean {
  const eps = 0.15;
  return startSec <= eps && endSec + eps >= duration;
}

/**
 * Clip [startSec, endSec] of a video source into a webm/mp4 Blob.
 * Both bounds are clamped to the source duration; maxDurationSec further caps
 * the clip length (default 10s, per the ref2v requirement).
 *
 * Fast-path: if the clip is the whole file and duration <= maxDuration, the
 * original blob is returned without re-encoding (preserves audio, avoids jank).
 */
export async function clipVideoToWebm(
  source: File | string,
  startSec: number,
  endSec: number,
  maxDurationSec = 10,
): Promise<ClipResult> {
  // Fast-path: if source is File and no trim needed, return original directly.
  if (source instanceof File) {
    try {
      const probeDur = await getVideoDuration(source);
      const safeStartProbe = Math.max(0, Math.min(startSec, probeDur));
      const safeEndProbe = Math.max(safeStartProbe, Math.min(endSec, safeStartProbe + maxDurationSec));
      if (isFullClip(safeStartProbe, safeEndProbe, probeDur) && probeDur <= maxDurationSec + 0.15) {
        return { blob: source, mimeType: source.type || 'video/webm' };
      }
    } catch {
      // probe failed -> fall through to normal path
    }
  } else if (typeof source === 'string') {
    try {
      const v = await loadVideoElement(source);
      const dur = v.duration;
      v.removeAttribute('src');
      v.load();
      const safeStart = Math.max(0, Math.min(startSec, dur));
      const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));
      if (isFullClip(safeStart, safeEnd, dur) && dur <= maxDurationSec + 0.15) {
        const res = await fetch(source);
        if (res.ok) {
          const blob = await res.blob();
          return { blob, mimeType: blob.type || 'video/webm' };
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

    if (isFullClip(safeStart, safeEnd, duration) && duration <= maxDurationSec + 0.15 && source instanceof File) {
      return { blob: source, mimeType: source.type || 'video/webm' };
    }

    const width = Math.max(2, Math.floor(video.videoWidth / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    const canvasStream = canvas.captureStream(24);

    // Preserve audio by merging audio track from video element.
    let audioTracks: MediaStreamTrack[] = [];
    try {
      const vs: MediaStream | undefined = (video as any).captureStream?.(24);
      if (vs) audioTracks = vs.getAudioTracks();
    } catch {
      // ignore
    }
    const combinedStream = audioTracks.length > 0
      ? new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks])
      : canvasStream;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(combinedStream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 4_000_000,
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

      const finish = (err?: unknown) => {
        if (finished) return;
        finished = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (rvcbId && (video as any).cancelVideoFrameCallback) {
          try { (video as any).cancelVideoFrameCallback(rvcbId); } catch {}
        }
        try { combinedStream.getTracks().forEach((t) => t.stop()); } catch {}
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (err) {
          reject(err);
        } else {
          const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
          resolve({ blob, mimeType: mimeType || 'video/webm' });
        }
      };

      const hangTimeout = window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* ignore */ }
        }
        finish();
      }, (safeEnd - safeStart + 5) * 1000);

      const onStop = () => {
        window.clearTimeout(hangTimeout);
        finish();
      };
      stopped.then(onStop).catch((err) => finish(err));

      let rafId = 0;
      let rvcbId = 0;

      const startRecorderIfNeeded = () => {
        if (!recorderStarted && video.currentTime >= safeStart) {
          recorderStarted = true;
          recorder.start(200);
          drawFrame();
        }
      };

      const hasRVFC = typeof (video as any).requestVideoFrameCallback === 'function';
      const loopRVFC = () => {
        if (finished) return;
        if (video.currentTime >= safeEnd) {
          if (recorder.state !== 'inactive') recorder.stop();
          else onStop();
          return;
        }
        drawFrame();
        rvcbId = (video as any).requestVideoFrameCallback(loopRVFC);
      };
      const loopRAF = () => {
        if (finished) return;
        if (video.currentTime >= safeEnd) {
          if (recorder.state !== 'inactive') recorder.stop();
          else onStop();
          return;
        }
        drawFrame();
        rafId = requestAnimationFrame(loopRAF);
      };

      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.play().catch(() => {});
        if (hasRVFC) {
          rvcbId = (video as any).requestVideoFrameCallback(loopRVFC);
        } else {
          rafId = requestAnimationFrame(loopRAF);
        }
      };

      video.addEventListener('seeked', onSeeked);
      video.ontimeupdate = () => {
        startRecorderIfNeeded();
      };

      if (video.currentTime >= safeStart && !recorderStarted) {
        recorderStarted = true;
        recorder.start(200);
        drawFrame();
      }
      if (Math.abs(video.currentTime - safeStart) > 0.01) {
        video.currentTime = safeStart;
      } else {
        onSeeked();
      }
    });
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/**
 * Extract a single frame (PNG Blob) from a video source. Used to generate a
 * poster/thumbnail for ref2v entries (which may not have a first image).
 */
export async function extractPosterFrame(
  source: File | string,
  atSec = 0,
): Promise<Blob> {
  const video = await loadVideoElement(source);
  try {
    const width = Math.max(2, Math.floor(video.videoWidth / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = Math.min(atSec, Math.max(0, (video.duration || 0) - 0.05));
    });

    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('Failed to extract poster frame');
    return blob;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** Convenience: read a File's duration (seconds). */
export function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    const url = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to read video metadata'));
    };
    video.src = url;
  });
}
