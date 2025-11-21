import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';

export const POST: RequestHandler = async ({ params, locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const videoId = params.id;
  
  const video = await getVideoById(videoId);
  if (!video) {
    return new Response(JSON.stringify({ error: 'Video not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const updated = await updateVideo(videoId, { is_published: false });
  
  return new Response(JSON.stringify({ success: true, video: updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
