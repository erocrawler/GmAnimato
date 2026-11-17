import type { RequestHandler } from '@sveltejs/kit';
import { createVideoEntryForReview } from '$lib/videoEntryCreation';
import { normalizeMediaRef } from '$lib/mediaPath';

const MAX_REF_IMAGE_URLS = 6;

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const mode = body?.mode || 'i2v';
    const rawOriginalImageUrl = body?.originalImageUrl;
    const rawLastImageUrl = body?.lastImageUrl;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : undefined;
    let additionalOptions = body?.additionalOptions && typeof body.additionalOptions === 'object' && !Array.isArray(body.additionalOptions)
      ? { ...body.additionalOptions }
      : undefined;

    const badRequest = (error: string) =>
      new Response(JSON.stringify({ error }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    // Every URL stored here is later fetched / probed by the server (analysis, kickoff, workflow build),
    // so only this site's own /media/... paths are accepted, never an arbitrary external address.
    if (!rawOriginalImageUrl) return badRequest('missing originalImageUrl');
    const originalImageUrl = normalizeMediaRef(rawOriginalImageUrl);
    if (!originalImageUrl) return badRequest('originalImageUrl must be a /media/... path');

    if (mode === 'fl2v' && !rawLastImageUrl) return badRequest('missing lastImageUrl for fl2v mode');
    let lastImageUrl: string | undefined;
    if (rawLastImageUrl != null && rawLastImageUrl !== '') {
      const safeLast = normalizeMediaRef(rawLastImageUrl);
      if (!safeLast) return badRequest('lastImageUrl must be a /media/... path');
      lastImageUrl = safeLast;
    }

    if (additionalOptions) {
      for (const key of ['ref_video_url', 'ref_audio_url'] as const) {
        const v = additionalOptions[key];
        if (v == null || v === '') continue;
        const safe = normalizeMediaRef(v);
        if (!safe) return badRequest(`${key} must be a /media/... path`);
        additionalOptions[key] = safe;
      }
      const refImages = additionalOptions.ref_image_urls;
      if (refImages != null) {
        if (!Array.isArray(refImages) || refImages.length > MAX_REF_IMAGE_URLS) {
          return badRequest('ref_image_urls must be a list of /media/... paths');
        }
        const safeImages: string[] = [];
        for (const u of refImages) {
          const safe = normalizeMediaRef(u);
          if (!safe) return badRequest('ref_image_urls must be a list of /media/... paths');
          safeImages.push(safe);
        }
        additionalOptions.ref_image_urls = safeImages;
      }
    }

    // Create video entry without auto recognition (manual analysis on review page)
    const result = await createVideoEntryForReview({
      userId: locals.user.id,
      mode,
      originalImageUrl,
      lastImageUrl,
      prompt,
      additionalOptions
    });

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: true, entry: result.entry }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Reuse image error:', error);
    return new Response(JSON.stringify({ error: 'failed to create video entry' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
