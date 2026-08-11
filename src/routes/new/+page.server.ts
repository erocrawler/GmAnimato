import type { Actions, PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { uploadBufferToS3 } from '$lib/s3';
import { Buffer } from 'buffer';
import { validateAndConvertImage } from '$lib/imageValidation';
import {
  validateAndConvertVideo,
  extractVideoPoster,
  probeVideoDuration,
  hasAudioFromBuffer,
  MAX_REF_VIDEO_SECONDS
} from '$lib/videoValidation';
import { createVideoEntryForReview } from '$lib/videoEntryCreation';
import { getVideosByUser, getWorkflows } from '$lib/db';
import { toOriginalUrl } from '$lib/serverImageUrl';

const MAX_REF_IMAGES = 6;

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, '/login');
  }
  // Completed videos the user can reuse as a ref video (proxied URLs load in a
  // same-origin <video>, so client-side clipping works without CORS issues).
  let reusableVideos: { id: string; prompt: string; url: string }[] = [];
  try {
    const page = await getVideosByUser(locals.user.id, 1, 20, {
      status: 'completed',
      sortBy: 'completion'
    });
    reusableVideos = (page.videos ?? [])
      .filter((v) => v.final_video_url)
      .map((v) => ({ id: v.id, prompt: v.prompt || '', url: v.final_video_url! }));
  } catch (e) {
    console.error('[New] Failed to load reusable videos:', e);
  }
  // Hide the ref2v mode until an admin has configured a ref2v workflow
  // (jobs can't run without one). Active (non-deleted) workflows only.
  let hasRef2vWorkflow = false;
  try {
    const workflows = await getWorkflows();
    hasRef2vWorkflow = workflows.some((w) => w.workflowType === 'ref2v');
  } catch (e) {
    console.error('[New] Failed to load workflows:', e);
  }

  return { reusableVideos, hasRef2vWorkflow };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) return { error: 'unauthenticated' };
    const form = await request.formData();
    const mode = form.get('mode')?.toString() || 'i2v';

    if (mode === 'fl2v') {
      // Handle FL2V mode with two images
      const firstFile = form.get('first_image') as File | null;
      const lastFile = form.get('last_image') as File | null;

      if (!firstFile || !lastFile) return { error: 'missing files' };

      // Process first image
      const firstArrayBuffer = await firstFile.arrayBuffer();
      let firstBuffer: Buffer<ArrayBufferLike> = Buffer.from(firstArrayBuffer);
      const firstResult = await validateAndConvertImage(firstBuffer);
      if (firstResult.error) {
        return { error: `First image: ${firstResult.error}` };
      }
      firstBuffer = firstResult.buffer;
      const firstExt = firstResult.ext || undefined;

      // Process last image
      const lastArrayBuffer = await lastFile.arrayBuffer();
      let lastBuffer: Buffer<ArrayBufferLike> = Buffer.from(lastArrayBuffer);
      const lastResult = await validateAndConvertImage(lastBuffer);
      if (lastResult.error) {
        return { error: `Last image: ${lastResult.error}` };
      }
      lastBuffer = lastResult.buffer;
      const lastExt = lastResult.ext || undefined;

      // Upload both images to S3
      const firstS3Url = await uploadBufferToS3(firstBuffer, firstExt);
      const lastS3Url = await uploadBufferToS3(lastBuffer, lastExt);

      // Create review entry for the uploaded images
      const result = await createVideoEntryForReview({
        userId: locals.user.id,
        mode: 'fl2v',
        originalImageUrl: firstS3Url,
        lastImageUrl: lastS3Url
      });

      if (!result.success) {
        return { error: result.error };
      }

      return { success: true, entry: result.entry };
    } else if (mode === 'ref2v') {
      // Handle Ref2V mode: optional reference video (client-clipped webm OR a
      // user-provided URL) + up to 6 optional reference images. Refs are ALL
      // optional — with none provided the workflow degrades to pure t2v.
      const refVideoFile = form.get('ref_video') as File | null;
      const refVideoUrlInput = form.get('ref_video_url')?.toString()?.trim() || '';
      if (refVideoFile && refVideoFile.size > 0) {
        console.log(`[Ref2V action] received ref_video: ${refVideoFile.name} (${refVideoFile.size}b)`);
      }

      // Upload ref video (if any) to S3. The buffer is validated + downscaled
      // to ~480p (long edge ≤854, aspect preserved, audio kept) via ffmpeg,
      // mirroring how ref images are validated/converted. Cross-origin URLs
      // can't be clipped client-side, so they're passed through as-is.
      let refVideoUrl = '';
      let refVideoName = '';
      let refVideoHasAudio: boolean | undefined;
      if (refVideoFile && refVideoFile.size > 0) {
        const rawVideoBuffer = Buffer.from(await refVideoFile.arrayBuffer());
        const videoResult = await validateAndConvertVideo(rawVideoBuffer, refVideoFile.type);
        if (videoResult.error) {
          return { error: videoResult.error };
        }
        refVideoUrl = await uploadBufferToS3(videoResult.buffer, videoResult.ext || 'webm');
        refVideoName = refVideoFile.name || `ref_video.${videoResult.ext || 'webm'}`;
        refVideoHasAudio = videoResult.hasAudio;
      } else if (refVideoUrlInput) {
        // Reused video without local re-encode (default trim) or cross-origin URL.
        // Normalize an absolute URL that points at our own /media/ proxy
        // (e.g. https://animato.gmgard.moe/media/wan/xxx.mp4) to the relative
        // /media/... form. The app's /media/ route requires a session and
        // would 403; the S3 object behind it is publicly readable, so probing
        // the S3 URL directly works from any host.
        const absMediaMatch = refVideoUrlInput.match(/^https?:\/\/[^/]+\/(media\/.+)$/i);
        const normalizedInput = absMediaMatch ? `/${absMediaMatch[1]}` : refVideoUrlInput;

        const isMediaProxy = normalizedInput.startsWith('/media/');
        const isHttpUrl = /^https?:\/\//i.test(normalizedInput);
        if (!isHttpUrl && !isMediaProxy) {
          return { error: 'ref video URL must be an http(s) URL' };
        }
        if (isHttpUrl) {
          const urlDuration = await probeVideoDuration(normalizedInput);
          if (urlDuration !== null && urlDuration > MAX_REF_VIDEO_SECONDS + 0.5) {
            return {
              error: `ref video is ${Math.round(urlDuration)}s — max ${MAX_REF_VIDEO_SECONDS}s. Please use a shorter clip or download it first.`
            };
          }
        }
        if (isMediaProxy) {
          // /media/ reuse: keep the proxied URL as-is to avoid re-upload, but
          // probe hasAudio so we know whether to keep the audio line in the workflow.
          refVideoUrl = normalizedInput;
          refVideoName = 'ref_video.webm';
          try {
            // Resolve /media/ to S3 URL for server-side probing (same logic as src/routes/media/[...path]/+server.ts)
            const s3Endpoint = env.S3_ENDPOINT;
            const mediaPath = normalizedInput.slice('/media/'.length);
            const s3Url = s3Endpoint ? `${s3Endpoint}/${mediaPath}` : normalizedInput;
            const mediaResp = await fetch(s3Url);
            if (mediaResp.ok) {
              const ab = await mediaResp.arrayBuffer();
              const buf = Buffer.from(ab);
              const hasAudio = await hasAudioFromBuffer(buf);
              if (hasAudio !== null) refVideoHasAudio = hasAudio;
            }
          } catch (e) {
            console.warn('[Ref2V] Failed to probe hasAudio for /media/ ref video:', e);
          }
        } else if (isHttpUrl) {
          try {
            const resp = await fetch(normalizedInput);
            if (!resp.ok) throw new Error(`fetch ref_video_url failed: ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());
            const ct = resp.headers.get('content-type') || 'video/webm';
            const videoResult2 = await validateAndConvertVideo(buf, ct);
            if (videoResult2.error) return { error: videoResult2.error };
            refVideoUrl = await uploadBufferToS3(videoResult2.buffer, videoResult2.ext || 'webm');
            refVideoName = `ref_video.${videoResult2.ext || 'webm'}`;
            refVideoHasAudio = videoResult2.hasAudio;
          } catch (e) {
            return { error: `ref_video_url fetch failed: ${String(e)}` };
          }
        } else {
          refVideoUrl = normalizedInput;
          refVideoName = 'ref_video.webm';
        }
      }

      // Process up to 6 ref images
      const refImageUrls: string[] = [];
      const refImageNames: string[] = [];
      for (let i = 1; i <= MAX_REF_IMAGES; i++) {
        const imgFile = form.get(`ref_image_${i}`) as File | null;
        if (!imgFile || imgFile.size === 0) continue;

        let imgBuffer: Buffer<ArrayBufferLike> = Buffer.from(await imgFile.arrayBuffer());
        const imgResult = await validateAndConvertImage(imgBuffer);
        if (imgResult.error) {
          return { error: `Ref image ${i}: ${imgResult.error}` };
        }
        imgBuffer = imgResult.buffer;
        const imgExt = imgResult.ext || undefined;
        const url = await uploadBufferToS3(imgBuffer, imgExt);
        refImageUrls.push(url);
        refImageNames.push(imgFile.name || `ref_image_${i}.${imgExt || 'png'}`);
      }

      // Poster/thumbnail: prefer the first ref image (it carries the intended
      // look and a probeable aspect); fall back to a server-side ffmpeg frame
      // extracted from the ref video when no ref images were provided.
      let posterUrl = '';
      if (refImageUrls.length > 0) {
        posterUrl = refImageUrls[0];
      }
      if (!posterUrl && refVideoUrl) {
        try {
          // ffmpeg needs an absolute, fetchable URL — convert the proxied
          // /media/... path to the S3 endpoint URL (same as jobWorkflow).
          const posterFrame = await extractVideoPoster(toOriginalUrl(refVideoUrl));
          if (posterFrame) {
            posterUrl = await uploadBufferToS3(posterFrame, 'png');
          }
        } catch (e) {
          console.warn('[Ref2V] Server poster extraction failed for', refVideoUrl, e);
        }
      }
      // Still no poster and no ref video? Pure text-to-video ref2v — leave empty, no hard error.

      // Client-carried ref video duration (seconds) so the review page can
      // offer "follow video duration" and the worker can match the output.
      const refVideoDurationInput = Number(form.get('ref_video_duration')?.toString());
      const refVideoDuration =
        Number.isFinite(refVideoDurationInput) && refVideoDurationInput > 0
          ? refVideoDurationInput
          : undefined;

      const result = await createVideoEntryForReview({
        userId: locals.user.id,
        mode: 'ref2v',
        originalImageUrl: posterUrl,
        additionalOptions: {
          ref2v: true,
          ref_video_url: refVideoUrl,
          ref_video_name: refVideoName,
          ...(refVideoHasAudio !== undefined ? { ref_video_has_audio: refVideoHasAudio } : {}),
          ...(refVideoDuration !== undefined ? { ref_video_duration: refVideoDuration } : {}),
          ref_image_urls: refImageUrls,
          ref_image_names: refImageNames
        }
      });

      if (!result.success) {
        return { error: result.error };
      }

      return { success: true, entry: result.entry };
    } else {
      // Handle I2V mode with single image
      const file = form.get('image') as File | null;

      if (!file) return { error: 'no file' };

      const arrayBuffer = await file.arrayBuffer();
      let buffer: Buffer<ArrayBufferLike> = Buffer.from(arrayBuffer);

      const validationResult = await validateAndConvertImage(buffer);
      if (validationResult.error) {
        return { error: validationResult.error };
      }
      buffer = validationResult.buffer;
      const ext = validationResult.ext || undefined;

      // Upload to S3; helper returns a public URL
      const s3Url = await uploadBufferToS3(buffer, ext);

      // Create review entry for the uploaded image
      const result = await createVideoEntryForReview({
        userId: locals.user.id,
        mode: 'i2v',
        originalImageUrl: s3Url
      });

      if (!result.success) {
        return { error: result.error };
      }

      return { success: true, entry: result.entry };
    }
  }
};
