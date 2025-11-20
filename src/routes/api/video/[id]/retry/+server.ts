import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, retryRunPodJob } from '$lib/runpod';

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

    const runpodConfig = getRunPodConfig({
      RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL,
      RUNPOD_API_KEY: env.RUNPOD_API_KEY
    });

    if (!runpodConfig) {
      return new Response(JSON.stringify({ error: 'RunPod not configured' }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    try {
      await retryRunPodJob(runpodConfig, video.job_id);
      
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
  } catch (err) {
    console.error('[Retry] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
