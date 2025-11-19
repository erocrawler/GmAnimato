import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ params }) => {
  try {
    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const video = await getVideoById(id);
    
    if (!video) {
      return new Response(JSON.stringify({ error: 'not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    if (video.status !== 'failed') {
      return new Response(JSON.stringify({ error: 'video is not in failed state' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    if (!video.job_id) {
      return new Response(JSON.stringify({ error: 'no job_id found for this video' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const VIDEO_RETRY_ENDPOINT_URL = env.VIDEO_RETRY_ENDPOINT_URL;
    const VIDEO_ENDPOINT_API_KEY = env.VIDEO_ENDPOINT_API_KEY;

    if (!VIDEO_RETRY_ENDPOINT_URL || !VIDEO_ENDPOINT_API_KEY) {
      return new Response(JSON.stringify({ error: 'VIDEO_RETRY_ENDPOINT_URL or VIDEO_ENDPOINT_API_KEY not configured' }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Call RunPod retry endpoint
    const retryUrl = `${VIDEO_RETRY_ENDPOINT_URL}/${video.job_id}`;
    console.log(`[Retry] Retrying job ${video.job_id} at ${retryUrl}`);

    const retryResponse = await fetch(retryUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VIDEO_ENDPOINT_API_KEY}`
      }
    });

    if (!retryResponse.ok) {
      const errorText = await retryResponse.text();
      console.error(`[Retry] Failed to retry job: ${retryResponse.status} - ${errorText}`);
      return new Response(
        JSON.stringify({ error: `Retry request failed: ${retryResponse.status}` }), 
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const retryResult = await retryResponse.json();
    console.log(`[Retry] Retry successful for job ${video.job_id}`, retryResult);

    // Update video status back to in_queue
    await updateVideo(id, { status: 'in_queue' });

    return new Response(JSON.stringify({ success: true, job_id: video.job_id }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
  } catch (err) {
    console.error('[Retry] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
