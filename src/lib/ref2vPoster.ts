/**
 * Ref2V poster refresh.
 *
 * For ref2v entries the poster (original_image_url) is captured at upload time
 * from the REFERENCE media — a frame of the ref video or the first ref image.
 * Once the generation completes, that poster no longer matches the output, so
 * we replace it with the first frame of the generated RESULT video. This keeps
 * gallery thumbnails and the "First Frame" panel showing the actual output.
 *
 * This module only EXTRACTS the poster and returns its URL; the caller merges
 * it into its own single updateVideo() call so a completed job triggers exactly
 * one database write. Best-effort by design: failures return null and are
 * logged — a poster refresh must never fail a completed job.
 */

import { uploadBufferToS3 } from '$lib/s3';
import { toOriginalUrl, toProxiedUrl } from '$lib/serverImageUrl';
import { extractVideoPoster } from '$lib/videoValidation';
import type { VideoEntry } from '$lib/IDatabase';

/**
 * Extract the first frame of the generated result video and upload it as the
 * new poster. Returns the proxied poster URL, or null when not applicable
 * (non-ref2v, missing result URL, or any extraction/upload failure).
 */
export async function extractRef2VPosterFromResult(
  video: Pick<VideoEntry, 'id' | 'additional_options'>,
  finalVideoUrl: string | undefined,
): Promise<string | null> {
  if (video.additional_options?.ref2v !== true) return null;
  if (!finalVideoUrl) return null;

  try {
    // final_video_url is stored proxied (/media/...); ffmpeg needs the real URL.
    const originalUrl = toOriginalUrl(finalVideoUrl);
    const frame = await extractVideoPoster(originalUrl, 0.1);
    if (!frame) {
      console.warn(`[Ref2V Poster] No frame extracted from result for video ${video.id}`);
      return null;
    }

    const uploadedUrl = await uploadBufferToS3(frame, 'png');
    const posterUrl = toProxiedUrl(uploadedUrl);
    console.log(`[Ref2V Poster] Extracted poster for video ${video.id} -> ${posterUrl}`);
    return posterUrl;
  } catch (err) {
    console.warn(`[Ref2V Poster] Failed to extract poster for video ${video.id}:`, err);
    return null;
  }
}
