import type { RequestHandler } from '@sveltejs/kit';
import { toggleLike } from '$lib/db';

export const POST: RequestHandler = async ({ params, locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const videoId = params.id;
    if (!videoId) {
      return new Response(JSON.stringify({ error: 'missing id' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Toggle like and get updated information in one call
    const result = await toggleLike(videoId, locals.user.id);

    if (!result) {
      return new Response(JSON.stringify({ error: 'Video not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    return new Response(JSON.stringify({ 
      success: true, 
      likesCount: (result as any).likesCount,
      isLiked: (result as any).isLiked
    }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
