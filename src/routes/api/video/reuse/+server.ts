import type { RequestHandler } from '@sveltejs/kit';
import { createVideoEntryWithRecognition } from '$lib/videoEntryCreation';

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

    // Create video entry with image recognition
    const result = await createVideoEntryWithRecognition({
      userId: locals.user.id,
      mode,
      originalImageUrl,
      lastImageUrl
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
