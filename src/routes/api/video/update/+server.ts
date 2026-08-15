import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById } from '$lib/db';
import { DB_LIMITS } from '$lib/validation';

/**
 * Publish/unpublish toggle for a video detail page, plus prompt auto-save
 * from the review page. Prompt writes are only accepted while the entry is
 * still editable ('uploaded') — once kickoff flips the status, the submitted
 * prompt is frozen and a stale auto-save must never overwrite it.
 */
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
    const is_published = body?.is_published as boolean | undefined;
    const prompt = body?.prompt as string | undefined;
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

    // Only pre-submission entries accept prompt writes — a debounced auto-save
    // racing a kickoff must never clobber the submitted prompt.
    if (prompt !== undefined && existing.status !== 'uploaded') {
      return new Response(JSON.stringify({ error: 'entry not editable' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Prevent publishing NSFW photo-realistic content to gallery
    if (is_published && existing.is_nsfw === true && existing.is_photo_realistic === true) {
      return new Response(
        JSON.stringify({ error: 'Cannot publish NSFW photo-realistic content to gallery' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Trim + cap the prompt at the DB column limit (DB_LIMITS.PROMPT — the same
    // limit validateVideoEntry enforces on kickoff/analyze).
    const patch: any = {};
    if (is_published !== undefined) patch.is_published = is_published;
    if (prompt !== undefined) patch.prompt = prompt.trim().slice(0, DB_LIMITS.PROMPT);
    const updated = await updateVideo(id, patch);
    return new Response(JSON.stringify({ success: true, updated }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

