import type { RequestHandler } from '@sveltejs/kit';
import { createVideoEntry, getDefaultWorkflow } from '$lib/db';
import { annotateImage } from '$lib/imageRecognition';
import { env } from '$env/dynamic/private';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const mode = body?.mode || 'i2v';
    const originalImageUrl = body?.originalImageUrl;
    const lastImageUrl = body?.lastImageUrl;

    if (!originalImageUrl) {
      return new Response(JSON.stringify({ error: 'missing originalImageUrl' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (mode === 'fl2v' && !lastImageUrl) {
      return new Response(JSON.stringify({ error: 'missing lastImageUrl for fl2v mode' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const grokApiKey = env.GROK_API_KEY;

    // Run image recognition
    const annotation = mode === 'fl2v'
      ? await annotateImage(originalImageUrl, grokApiKey, lastImageUrl)
      : await annotateImage(originalImageUrl, grokApiKey);

    // Validate field lengths
    const validationData = mode === 'fl2v'
      ? {
          original_image_url: originalImageUrl,
          last_image_url: lastImageUrl,
          prompt: '',
          tags: annotation.tags,
          suggested_prompts: annotation.suggested_prompts,
        }
      : {
          original_image_url: originalImageUrl,
          prompt: '',
          tags: annotation.tags,
          suggested_prompts: annotation.suggested_prompts,
        };

    const validationErrors = validateVideoEntry(validationData);
    if (validationErrors.length > 0) {
      return new Response(JSON.stringify({ error: formatValidationErrors(validationErrors) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get default workflow for the mode
    const defaultWorkflow = await getDefaultWorkflow(mode);

    // Create video entry with reused image URLs
    const entry = await createVideoEntry({
      user_id: locals.user.id,
      workflow_id: defaultWorkflow?.id,
      original_image_url: originalImageUrl,
      last_image_url: mode === 'fl2v' ? lastImageUrl : undefined,
      prompt: '',
      tags: annotation.tags,
      suggested_prompts: annotation.suggested_prompts,
      is_photo_realistic: annotation.is_photo_realistic,
      is_nsfw: annotation.is_nsfw,
      status: 'uploaded',
      is_published: false
    });

    return new Response(JSON.stringify({ success: true, entry }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Reuse image error:', error);
    return new Response(JSON.stringify({ error: 'failed to create video entry' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
