import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById } from '$lib/db';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const body = await request.json();
    const id = body?.id as string | undefined;
    const prompt = body?.prompt as string | undefined;
    const tags = body?.tags as string[] | undefined;
    const is_published = body?.is_published as boolean | undefined;
    if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const existing = await getVideoById(id);
    if (!existing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    // Check ownership
    if (existing.user_id !== locals.user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Validate field lengths
    const validationErrors = validateVideoEntry({ prompt, tags });
    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({ error: formatValidationErrors(validationErrors) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Prevent publishing NSFW photo-realistic content to gallery
    if (is_published && existing.is_nsfw && existing.is_photo_realistic) {
      return new Response(
        JSON.stringify({ error: 'Cannot publish NSFW photo-realistic content to gallery' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Prevent publishing if image recognition failed (no suggested prompts)
    if (is_published && (!existing.suggested_prompts || existing.suggested_prompts.length === 0)) {
      return new Response(
        JSON.stringify({ error: 'Cannot publish to gallery - image recognition failed. Please try uploading again.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const updated = await updateVideo(id, { prompt, tags, is_published });
    return new Response(JSON.stringify({ success: true, updated }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

