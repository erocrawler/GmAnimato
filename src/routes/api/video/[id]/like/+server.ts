import type { RequestHandler } from '@sveltejs/kit';
import { toggleLike, getVideoById } from '$lib/db';

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

    // Check if video exists
    const video = await getVideoById(videoId);
    if (!video) {
      return new Response(JSON.stringify({ error: 'Video not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Toggle like
    const updated = await toggleLike(videoId, locals.user.id);

    return new Response(JSON.stringify({ 
      success: true, 
      likes: updated?.likes || [],
      likesCount: updated?.likes?.length || 0
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
