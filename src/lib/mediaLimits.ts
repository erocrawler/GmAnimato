/**
 * Media limits shared by server validation and client-side pre-checks.
 *
 * This module is intentionally dependency-free so it can be imported from BOTH
 * server code (loaders/actions) and browser code (svelte components). The
 * validation *functions* live in `imageValidation.ts` / `videoValidation.ts`
 * because they need node-only deps (sharp, ffmpeg) — keep those imports out of
 * this file so the client can import the constants directly.
 */

// ---- Duration (generation output + ref2v reference-video upload cap) ----
// The max allowed OUTPUT duration by entitlement tier. Free tier 6s,
// advanced/paid tier 15s (MiniMax H3 premium-only at the top end; the kickoff
// route still rejects 15s for non-MiniMax workflows). The ref2v reference-video
// upload cap simply IS this value — a ref video longer than the max allowed
// output duration can't be followed meaningfully.
export const MAX_DURATION_SECONDS_FREE = 6;
export const MAX_DURATION_SECONDS_PAID = 15;

/** The max allowed duration for a tier: 6s free, 15s advanced. */
export function maxAllowedDurationSeconds(hasAdvancedFeatures: boolean): 6 | 15 {
  return hasAdvancedFeatures ? MAX_DURATION_SECONDS_PAID : MAX_DURATION_SECONDS_FREE;
}

// ---- Images (ref images, i2v/fl2v first/last frames) ----
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
/** Upload formats accepted as-is; anything else is converted to JPEG. */
export const ALLOWED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

// ---- Reference videos (ref2v) ----
/** 50 MB safety cap (the client clips to ≤ the tier's max duration webm). */
export const MAX_REF_VIDEO_BYTES = 50 * 1024 * 1024;
// Note: MKV appears as both 'video/x-matroska' (legacy, most Chromium builds)
// and 'video/matroska' (IANA-registered, some browsers/tools) — accept both.
export const ALLOWED_VIDEO_TYPES = new Set(['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/matroska']);
/** Downscale ref videos so the long edge is at most 854px (~480p 16:9). Ref
 *  videos only condition the output (generated at 480p), so a smaller upload
 *  is faster to upload and cheaper for the worker to decode (VHS_LoadVideo). */
export const MAX_VIDEO_LONG_EDGE = 854;
/** The ref2v model's frame rate. The worker's VHS_LoadVideo runs with
 *  `force_rate: 24`, so the reference is resampled to this rate before it
 *  conditions the generation. Uploads are capped to it (downsample only —
 *  never upsampled, so a 12fps source stays 12fps) and the minimum-frame
 *  guard counts frames at this rate. */
export const MAX_REF_VIDEO_FPS = 24;
/** Minimum frames a reference video must carry. The ref2v model conditions on
 *  the video's decoded frame batch, so a clip holding only a handful of frames
 *  (e.g. a fraction-of-a-second selection) is unusable and makes the worker job
 *  fail. Guarded at upload time and again when the workflow is built. */
export const MIN_REF_VIDEO_FRAMES = 5;
