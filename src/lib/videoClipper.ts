/**
 * Client-side reference video utilities for Ref2V (MiniMax H3).
 *
 * - `clipVideoToWebm`: clips a source video (File or URL) to a webm Blob using
 *   `<video>` + `canvas.captureStream()` + `MediaRecorder`. No server transcode.
 * - `extractPosterFrame`: grabs a frame as a PNG Blob (used as the entry's
 *   `original_image_url` thumbnail, since ref2v may have no "first image").
 *
 * Notes:
 * - The source must be same-origin or CORS-enabled, otherwise the canvas is
 *   tainted and `captureStream`/`toBlob` fail. The site's `/media/...` proxy is
 *   same-origin, so reused videos work.
 * - WebM (VP8/Opus) is chosen because VHS `LoadVideo` (already installed in the
 *   worker) decodes it, and `uploadBufferToS3` supports the `video/webm` type.
 */

// MP4 is preferred: Chromium's MediaRecorder writes a proper moov/duration for
// mp4, while its webm muxer produces files Chromium's own demuxer can't open
// (DEMUXER_ERROR_COULD_NOT_OPEN — missing duration/cues). MP4 also matches the
// server's primary upload format (validateAndConvertVideo re-encodes to mp4)
// and VHS LoadVideo decodes it.
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

/** Strip codec params from a MediaRecorder MIME so blob/File Content-Type stays
 *  clean ('video/mp4;codecs=avc1.42E01E,mp4a.40.2' -> 'video/mp4'). A blob URL
 *  whose Content-Type carries a codecs string can confuse the demuxer. */
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

/**
 * Clip [startSec, endSec] of a video source into a webm/mp4 Blob.
 * Both bounds are clamped to the source duration; maxDurationSec further caps
 * the clip length (default 10s, per the ref2v requirement).
 *
 * When includeAudio is true (default), the source's audio track is captured
 * alongside the canvas video stream (the source must be same-origin/CORS-
 * enabled, which the caller's canClipRefVideo gate ensures). Canvas streams
 * are video-only, so audio must be added explicitly.
 */
export async function clipVideoToWebm(
  source: File | string,
  startSec: number,
  endSec: number,
  maxDurationSec = 10,
  includeAudio = true,
): Promise<ClipResult> {
  const video = await loadVideoElement(source);
  try {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Invalid video duration');
    }

    const safeStart = Math.max(0, Math.min(startSec, duration));
    const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));

    // Draw into a canvas sized to the video's natural dimensions (rounded to
    // even numbers to keep VP8/VP9 encoders happy).
    const width = Math.max(2, Math.floor(video.videoWidth / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight / 2) * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    const stream = canvas.captureStream(24);
    if (includeAudio) {
      // Combine the source's audio track(s) with the canvas video stream.
      const srcStream = (video as any).captureStream?.() || (video as any).mozCaptureStream?.();
      if (srcStream) {
        for (const track of srcStream.getAudioTracks()) {
          stream.addTrack(track);
        }
      }
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 4_000_000,
      ...(includeAudio && stream.getAudioTracks().length > 0
        ? { audioBitsPerSecond: 128_000 }
        : {}),
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

    // Seek to the start bound, then begin recording once playback reaches it.
    // Note: setting currentTime to 0 may be a no-op (no 'seeked' event), so
    // start playback unconditionally after seeking and detect the start bound
    // via timeupdate. Recorder is stopped exactly at the end bound. A safety
    // timeout guards against stalls (e.g. autoplay blocked without a gesture).
    return new Promise((resolve, reject) => {
      let recorderStarted = false;
      let finished = false;
      let stopTimer = 0;

      const finish = (err?: unknown) => {
        if (finished) return;
        finished = true;
        if (stopTimer) window.clearInterval(stopTimer);
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

      // Safety: if playback stalls (autoplay blocked / seek never lands),
      // stop the recorder after (safeEnd - safeStart + 5)s. Crucially we do
      // NOT build the blob here: recorder.stop() flushes the webm's final
      // metadata (SeekHead / Info / Cues) via a queued dataavailable event,
      // and we must wait for onstop (stopped.then(onStop)) so the blob is
      // complete and playable. Building from `chunks` early yields a webm the
      // demuxer cannot open (DEMUXER_ERROR_COULD_NOT_OPEN).
      const hangTimeout = window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { /* ignore */ }
          // onStop (→ finish) fires via `stopped.then(onStop)` after the
          // final data flush.
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
        video.play().catch(() => {
          /* play may be blocked; timeupdate may still advance in some browsers */
        });
      };

      // Poll playback; stop exactly at the end bound.
      stopTimer = window.setInterval(() => {
        if (video.currentTime >= safeEnd) {
          if (recorder.state !== 'inactive') recorder.stop();
          else onStop();
        } else {
          drawFrame();
        }
      }, 50);

      // If we're already at (or past) the start bound, begin immediately.
      if (video.currentTime >= safeStart && !recorderStarted) {
        recorderStarted = true;
        recorder.start(200);
        drawFrame();
      }

      video.addEventListener('seeked', onSeeked);
      video.ontimeupdate = () => {
        if (video.currentTime >= safeStart && !recorderStarted) {
          recorderStarted = true;
          recorder.start(200);
          drawFrame();
        }
      };

      if (Math.abs(video.currentTime - safeStart) > 0.01) {
        video.currentTime = safeStart;
      } else {
        onSeeked();
      }
    });
  } catch (err) {
    // Only clean up when the video never started recording (the promise's
    // finish() handles cleanup for the normal/completed path). Stripping the
    // src in a finally here would abort playback before recording begins.
    video.removeAttribute('src');
    video.load();
    throw err;
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
export function getVideoDuration(source: File | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
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
