import type { RequestHandler } from '@sveltejs/kit';
import { createVideoEntryForReview } from '$lib/videoEntryCreation';

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const mode = body?.mode || 'i2v';
    const originalImageUrl = body?.originalImageUrl;
    const lastImageUrl = body?.lastImageUrl;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : undefined;
    const additionalOptions = body?.additionalOptions && typeof body.additionalOptions === 'object' ? body.additionalOptions : undefined;

    if (!originalImageUrl) {
      return new Response(JSON.stringify({ error: 'missing originalImageUrl' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (mode === 'fl2v' && !lastImageUrl) {
      return new Response(JSON.stringify({ error: 'missing lastImageUrl for fl2v mode' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
