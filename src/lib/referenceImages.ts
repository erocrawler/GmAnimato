/**
 * Labeled reference images for the vision model.
 *
 * Shared by prompt enhancement and the "Analyze with AI" recommendation so both
 * see the same material: for ref2v every reference image (<Picture N>) plus
 * sampled screenshots of the reference video (<Video 1>); for fl2v the first and
 * last frame; for i2v the main image. Each image carries a caption binding it to
 * its tag so the model can tell which upload is which.
 */

import type { VideoEntry } from '$lib/IDatabase';
import { toOriginalUrl } from '$lib/serverImageUrl';
import { extractVideoScreenshots } from '$lib/videoValidation';
import { uploadBufferToS3 } from '$lib/s3';

export type ReferenceWorkflowType = 'ref2v' | 'fl2v' | 'i2v';

export interface LabeledReferenceImage {
  label: string;
  url: string;
}

const MAX_REF_IMAGES = 6;
const REF_VIDEO_SCREENSHOTS = 3;

export function detectReferenceWorkflowType(
  video: Pick<VideoEntry, 'additional_options' | 'last_image_url'>,
  requested?: string
): ReferenceWorkflowType {
  if (requested === 'ref2v' || requested === 'fl2v' || requested === 'i2v') return requested;
  if (video.additional_options?.ref2v === true) return 'ref2v';
  return video.last_image_url ? 'fl2v' : 'i2v';
}

export async function collectLabeledReferenceImages(
  video: Pick<VideoEntry, 'additional_options' | 'original_image_url' | 'last_image_url'>,
  workflowType: ReferenceWorkflowType
): Promise<LabeledReferenceImage[]> {
  const labeledImages: LabeledReferenceImage[] = [];
  if (workflowType === 'ref2v') {
    // ref2v: reference images are <Picture N>; screenshots from the ref
    // video are <Video 1> 截图 N/M.
    const refImages: string[] = video.additional_options?.ref_image_urls ?? [];
    refImages.slice(0, MAX_REF_IMAGES).forEach((u, i) => {
      labeledImages.push({ label: `<Picture ${i + 1}>`, url: u });
    });

    const refVideoUrl = video.additional_options?.ref_video_url;
    if (refVideoUrl) {
      const screenshots = await extractVideoScreenshots(toOriginalUrl(refVideoUrl), REF_VIDEO_SCREENSHOTS);
      for (let i = 0; i < screenshots.length; i++) {
        try {
          const shotUrl = await uploadBufferToS3(screenshots[i], 'jpg');
          if (shotUrl) {
            labeledImages.push({
              label: `<Video 1> 截图 ${i + 1}/${screenshots.length}`,
              url: shotUrl,
            });
          }
        } catch (e) {
          console.warn('[reference-images] Failed to upload ref-video screenshot:', e);
        }
      }
    }

    // Fall back to the poster frame if no refs at all (pure t2v).
    if (labeledImages.length === 0 && video.original_image_url) {
      labeledImages.push({ label: '主图像', url: video.original_image_url });
    }
  } else if (workflowType === 'fl2v') {
    if (video.original_image_url) labeledImages.push({ label: '首帧 (first frame)', url: video.original_image_url });
    if (video.last_image_url) labeledImages.push({ label: '尾帧 (last frame)', url: video.last_image_url });
  } else {
    if (video.original_image_url) labeledImages.push({ label: '主图像', url: video.original_image_url });
  }
  // Proxied /media/ URLs back to S3 URLs — the VL client fetches them server-side.
  for (const item of labeledImages) {
    item.url = toOriginalUrl(item.url);
  }
  return labeledImages.filter((x) => x.url);
}
