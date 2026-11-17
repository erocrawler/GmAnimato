import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, deleteVideo } from '$lib/db';
import { errorResponse, jsonResponse, serializeVideoDetail } from '$lib/agentApi';
import { jsonServerError } from '$lib/server/safe-error';

/**
 * GET /api/video/{id} — detail of one video (owner or admin; anyone else gets a
 * 404 so ids cannot be probed).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return errorResponse(401, 'Authentication required', 'unauthenticated');
  const id = params.id;
  const video = id ? await getVideoById(id) : undefined;
  const isAdmin = locals.user.roles?.includes('admin');
  if (!video || video.status === 'deleted' || (video.user_id !== locals.user.id && !isAdmin)) {
    return errorResponse(404, 'not found', 'not_found');
  }
  return jsonResponse(serializeVideoDetail(video));
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Get the video
    const video = await getVideoById(id);
    if (!video) {
      return new Response(JSON.stringify({ error: 'not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Check ownership
    if (video.user_id !== locals.user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Don't allow deletion while a job is queued or running. The UI never offers it (VideoList / ReviewActionBar disable
    // it for in_queue and processing); a queued job may already be at RunPod, and deleting the row would free its quota
    // credit while the job still runs.
    if (video.status === 'processing' || video.status === 'in_queue') {
      return new Response(JSON.stringify({ error: 'Cannot delete video while it is queued or processing' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Delete the video
    await deleteVideo(id);

    return new Response(JSON.stringify({ success: true }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
  } catch (err) {
    return jsonServerError('[Video Delete] Error', err);
  }
};
