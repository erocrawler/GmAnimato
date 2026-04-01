import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { annotateImage } from '$lib/imageRecognition';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';
import { toOriginalUrl } from '$lib/serverImageUrl';

export const POST: RequestHandler = async ({ params, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const video = await getVideoById(id);
    if (!video) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isAdmin = locals.user.roles?.includes('admin');
    if (video.user_id !== locals.user.id && !isAdmin) {
      return new Response(JSON.stringify({ error: 'access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const requestedAt = new Date().toISOString();
    await updateVideo(id, {
      validation_metadata: {
        ...(video.validation_metadata || {}),
        manual_recognition_done: false,
        manual_recognition_requested_at: requestedAt,
        manual_recognition_completed_at: undefined,
        manual_recognition_error: undefined,
      },
    });

    const annotation = await annotateImage(
      toOriginalUrl(video.original_image_url),
      video.last_image_url ? toOriginalUrl(video.last_image_url) : undefined,
      video.user_id,
      video.id
    );

    const hasAnyResult =
      annotation.tags.length > 0 ||
      annotation.suggested_prompts.length > 0 ||
      annotation.is_photo_realistic !== undefined ||
      annotation.is_nsfw !== undefined;

    if (!hasAnyResult) {
      const failed = await updateVideo(id, {
        validation_metadata: {
          ...(video.validation_metadata || {}),
          manual_recognition_done: false,
          manual_recognition_requested_at: requestedAt,
          manual_recognition_completed_at: new Date().toISOString(),
          manual_recognition_error: 'analysis_unavailable',
        },
      });

      return new Response(
        JSON.stringify({
          success: false,
          errorCode: 'analysis_unavailable',
          entry: failed,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationErrors = validateVideoEntry({
      tags: annotation.tags,
      suggested_prompts: annotation.suggested_prompts,
    });

    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({ error: formatValidationErrors(validationErrors) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const patch: any = {
      tags: annotation.tags,
      suggested_prompts: annotation.suggested_prompts,
      validation_metadata: {
        ...(video.validation_metadata || {}),
        manual_recognition_done: true,
        manual_recognition_requested_at: requestedAt,
        manual_recognition_completed_at: new Date().toISOString(),
        manual_recognition_error: undefined,
      },
    };

    if (annotation.is_photo_realistic !== undefined) {
      patch.is_photo_realistic = annotation.is_photo_realistic;
    }

    if (annotation.is_nsfw !== undefined) {
      patch.is_nsfw = annotation.is_nsfw;
    }

    if (annotation.is_photo_realistic !== undefined || annotation.is_nsfw !== undefined) {
      patch.validation_metadata.revalidation_status = 'completed';
      patch.validation_metadata.revalidation_completed_at = new Date().toISOString();
      patch.validation_metadata.revalidation_error = undefined;
    }

    const updated = await updateVideo(id, patch);

    return new Response(JSON.stringify({ success: true, entry: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[Manual Analysis] Failed:', error);
    return new Response(JSON.stringify({ error: 'failed to analyze image' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
