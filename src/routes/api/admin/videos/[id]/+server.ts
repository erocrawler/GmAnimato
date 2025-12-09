import type { RequestHandler } from '@sveltejs/kit';
import { deleteVideo } from '$lib/db';

export const DELETE: RequestHandler = async ({ params, locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const videoId = params.id;
  
  if (!videoId) {
    return new Response(JSON.stringify({ error: 'Video ID is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const deleted = await deleteVideo(videoId);
  
  if (!deleted) {
    return new Response(JSON.stringify({ error: 'Video not found or failed to delete' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
