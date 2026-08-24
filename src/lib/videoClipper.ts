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
// NOTE: prefer the BARE 'video/mp4' — Chrome's MediaRecorder REJECTS the
// explicit codec string 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' (isTypeSupported
// says true but recording errors out with 0 chunks). Bare mp4 records fine.
import { MAX_DURATION_SECONDS_FREE } from './mediaLimits';
const MIME_CANDIDATES = [
  'video/mp4',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
// Video-ONLY candidates (no audio codec) — used when the recorded stream has
// NO audio tracks. Firefox throws "an audio track cannot be recorded: ...vp8
// indicates an unsupported codec" if the stream has audio but the codec
// doesn't, and (per probing) a video-only codec with an audio-less stream is
// the reliable combo. Order: vp8 first — vp9 is NOT supported by Firefox's
// MediaRecorder (isTypeSupported returned false in the probe).
const MIME_VIDEO_ONLY = ['video/webm;codecs=vp8', 'video/webm'];

function pickMimeType(hasAudio: boolean): string {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser');
  }
  const list = hasAudio ? MIME_CANDIDATES : MIME_VIDEO_ONLY;
  for (const mime of list) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  // Fall back to the general list.
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
    // CRITICAL (Firefox): a MUTED video's captureStream can produce NO frames
    // (the media pipeline treats muted as "no presentation"). The video is
    // off-screen anyway, so use volume=0 (silent) instead of muted=true so
    // frames actually flow into the recorder.
    video.muted = false;
    video.volume = 0;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    // Keep the video in the DOM hidden off-screen (NOT display:none, which can
    // suppress rendering): this keeps frames being decoded/presented so
    // canvas.drawImage always has a frame, and is required for reliable
    // captureStream on Firefox. Cleaned up by callers (video.remove()).
    video.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body?.appendChild(video);

    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const src = typeof source === 'string' ? source : objectUrl!;

    const cleanup = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
      video.remove();
    };

    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(loadTimeout);
      console.warn('[Clip] loadVideoElement failed:', msg);
      cleanup();
      reject(new Error(msg));
    };

    // Hard timeout: if the browser never fires loadedmetadata OR error
    // (e.g. a file it can partially parse but not decode), reject instead
    // of hanging forever.
    const loadTimeout = window.setTimeout(
      () => fail('Timed out waiting for video metadata (15s)'),
      15000,
    );

    const onError = () => {
      fail(`Failed to load video source (${video.error?.code ?? 'unknown'})`);
    };

    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(loadTimeout);
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
 * Default maxDurationSec is the free-tier max allowed duration — callers
 * (ref2v upload UI) pass their tier cap explicitly (6s free / 15s paid).
 */
export async function clipVideoToWebm(
  source: File | string,
  startSec: number,
  endSec: number,
  maxDurationSec = MAX_DURATION_SECONDS_FREE,
  includeAudio = true,
): Promise<ClipResult> {
  // Fast-path: original File, no trim needed AND audio kept. When the user
  // asked to drop audio (includeAudio=false) we can't return the original
  // bytes — the canvas/MediaRecorder path below is what actually strips it.
  if (source instanceof File) {
    try {
      const probeDur = await getVideoDuration(source);
      const safeStart = Math.max(0, Math.min(startSec, probeDur));
      const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));
      if (includeAudio !== false && isFullClip(safeStart, safeEnd, probeDur) && probeDur <= maxDurationSec + 0.05) {
        return { blob: source, mimeType: source.type || 'video/mp4' };
      }
    } catch (e) {
      // probe failed -> fall through
      console.warn('[Clip] fast-path probe failed, falling through:', e);
    }
  } else if (typeof source === 'string') {
    try {
      const v = await loadVideoElement(source);
      const dur = v.duration;
      v.removeAttribute('src');
      v.load();
      v.remove();
      const safeStart = Math.max(0, Math.min(startSec, dur));
      const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));
      if (includeAudio !== false && isFullClip(safeStart, safeEnd, dur) && dur <= maxDurationSec + 0.05) {
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
  // Hoisted so the catch below can clean it up on any error path.
  let canvas: HTMLCanvasElement | undefined;
  try {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Invalid video duration');
    }

    const safeStart = Math.max(0, Math.min(startSec, duration));
    const safeEnd = Math.max(safeStart, Math.min(endSec, safeStart + maxDurationSec));

    if (includeAudio !== false && isFullClip(safeStart, safeEnd, duration) && duration <= maxDurationSec + 0.05 && source instanceof File) {
      return { blob: source, mimeType: source.type || 'video/mp4' };
    }

    // PREFERRED: record the media element's OWN stream (video.captureStream /
    // mozCaptureStream). Firefox drives this from the media pipeline — frames
    // flow as the video plays, independent of canvas painting/compositing,
    // so MediaRecorder reliably gets data (the canvas round-trip below was
    // producing ZERO frames on Firefox because the off-screen canvas was never
    // painted → 0 dataavailable over the whole clip).
    let stream: MediaStream | null = null;
    const elStream = (video as any).captureStream?.() || (video as any).mozCaptureStream?.();
    if (elStream) {
      stream = elStream;
      // The element stream's audio tracks are authoritative: keep them unless
      // the user explicitly asked to drop audio.
      if (!includeAudio) {
        for (const t of Array.from(elStream.getAudioTracks())) elStream.removeTrack(t);
      }
      const vTracks = elStream.getVideoTracks();
      // If the element stream has no LIVE video track, fall through to canvas.
      if (vTracks.length === 0 || vTracks.some((t: any) => t.readyState === 'ended')) {
        console.warn('[Clip] element captureStream has no live video track — falling back to canvas');
        stream = null;
      }
    }

    // FALLBACK: canvas round-trip (browsers without HTMLMediaElement.captureStream).
    // The canvas must be in the DOM AND actually visible (tiny, near-opaque) —
    // Firefox only emits captureStream frames for canvases it paints; fully
    // transparent off-screen canvases emit nothing.
    let drawFrame: () => void = () => {};
    if (!stream) {
      const width = Math.max(2, Math.floor(video.videoWidth / 2) * 2);
      const height = Math.max(2, Math.floor(video.videoHeight / 2) * 2);
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.style.cssText =
        'position:fixed;top:0;left:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:-1;';
      document.body?.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      stream = canvas.captureStream(24);
      if (includeAudio) {
        try {
          const aStream = (video as any).captureStream?.() || (video as any).mozCaptureStream?.();
          if (aStream) {
            for (const track of aStream.getAudioTracks()) stream.addTrack(track);
          }
        } catch {
          // ignore — no audio track or captureStream not supported
        }
      }
      drawFrame = () => ctx.drawImage(video, 0, 0, width, height);
    }

    const streamHasAudio = stream.getAudioTracks().length > 0;
    const mimeType = pickMimeType(streamHasAudio);
    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 4_000_000,
      ...(streamHasAudio ? { audioBitsPerSecond: 128_000 } : {}),
    });

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (e) => reject(e as unknown as Error);
    });

    return new Promise((resolve, reject) => {
      let recorderStarted = false;
      let finished = false;
      let rafId = 0;

      const finish = (err?: unknown) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(hangTimeout);
        if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
        canvas?.remove();
        // NEVER resolve an empty blob: a recorder that stopped with zero data
        // (Firefox MediaRecorder death with a poisoned audio track) would
        // upload as a 0-byte file → "no video" entry. Treat as a hard error
        // so applyClip falls back to the server.
        if (!err && chunks.length === 0) {
          err = new Error('MediaRecorder produced no data (clip failed)');
        }
        if (err) {
          console.warn('[Clip] finish with error:', err);
          reject(err);
        } else {
          const cleanMime = baseMimeType(mimeType);
          const blob = new Blob(chunks, { type: cleanMime });
          resolve({ blob, mimeType: cleanMime });
        }
      };

      const hangTimeout = window.setTimeout(() => {
        console.warn('[Clip] HANG TIMEOUT fired — forcing stop. recorder state:', recorder.state, 'currentTime:', video.currentTime, 'chunks:', chunks.length);
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
      // Surface recorder errors (e.g. Firefox refusing to encode the track
      // set) as failures so they never become a 0-byte upload.
      stopped.then(onStop).catch((err) => finish(err));

      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.play().catch((e) => console.warn('[Clip] play() rejected:', e));
      };

      // rAF-based stop loop — deterministic across browsers. RVFC is NOT used:
      // Firefox only fires requestVideoFrameCallback for frames actually sent
      // to the compositor, and once the off-screen element stops being
      // composited the callbacks go silent (video keeps playing, but checkStop
      // never runs again) — exactly the hang we saw. rAF in a foreground tab
      // runs at 60Hz, giving ±16ms stop precision (the original setInterval(50)
      // had ±50ms jitter, which RVFC was meant to fix — rAF is good enough).
      const checkStop = () => {
        if (finished) return;
        if (video.currentTime >= safeEnd) {
          if (recorder.state !== 'inactive') recorder.stop();
          else onStop();
          return;
        }
        drawFrame();
        rafId = requestAnimationFrame(checkStop);
      };

      if (video.currentTime >= safeStart && !recorderStarted) {
        recorderStarted = true;
        recorder.start(200);
        drawFrame();
        checkStop(); // start the stop loop
      }

      video.addEventListener('seeked', onSeeked);
      video.ontimeupdate = () => {
        if (video.currentTime >= safeStart && !recorderStarted) {
          recorderStarted = true;
          recorder.start(200);
          drawFrame();
          checkStop(); // start the stop loop
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
    video.remove();
    canvas?.remove();
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
    video.remove();
  }
}

export function getVideoDuration(source: File | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const url = typeof source === 'string' ? source : objectUrl!;

    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      console.warn('[Clip] getVideoDuration failed:', msg);
      reject(new Error(msg));
    };

    // Hard timeout: neither onloadedmetadata nor onerror may fire for files
    // the browser can partially parse — reject instead of hanging forever.
    const timeout = window.setTimeout(() => fail('Timed out probing video duration (10s)'), 10000);

    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(video.duration);
    };
    video.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      fail(`Failed to read video metadata (${video.error?.code ?? 'unknown'})`);
    };
    video.src = url;
  });
}
