import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById, getActiveJobsByUser, getAdminSettings } from '$lib/db';
import { env } from '$env/dynamic/private';
import { buildWorkflow } from '$lib/i2vWorkflow';
import { getRunPodConfig, submitRunPodJob, getRunPodHealth } from '$lib/runpod';

async function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const id = body?.id as string | undefined;
    if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const existing = await getVideoById(id);
    if (!existing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    if (existing.status === 'processing' || existing.status === 'in_queue') {
      return new Response(JSON.stringify({ error: 'already processing' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Get admin settings for thresholds
    const settings = await getAdminSettings();

    // Check if RunPod is configured
    const runpodConfig = getRunPodConfig({
      RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL,
      RUNPOD_API_KEY: env.RUNPOD_API_KEY
    });

    if (!runpodConfig) {
      // Fall back to mock I2V workflow
      console.log(`[Mock I2V] RUNPOD_ENDPOINT_URL or RUNPOD_API_KEY not configured, using mock workflow`);
      await updateVideo(id, { status: 'in_queue' });
      const origin = new URL(request.url).origin;
      (async () => {
        console.log(`[Mock I2V] Starting background job for ${id} at ${origin}`);
        await delay(1500); // simulate work
        try {
          console.log(`[Mock I2V] Sending webhook for ${id} to ${origin}/api/i2v-webhook/${id}`);
          const res = await fetch(`${origin}/api/i2v-webhook/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              id: 'mock-job-id', 
              status: 'COMPLETED', 
              files: [
                {
                  filename: 'output.mp4',
                  type: 's3_url',
                  data: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
                }
              ]
            })
          });
          console.log(`[Mock I2V] Webhook response status: ${res.status}`);
          if (!res.ok) {
            const text = await res.text();
            console.error(`[Mock I2V] Webhook failed response: ${text}`);
          }
        } catch (err) {
          console.error('[Mock I2V] mock webhook failed', err);
        }
      })();

      return new Response(JSON.stringify({ success: true, mock: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Check user's concurrent job limit
    const activeJobs = await getActiveJobsByUser(existing.user_id);
    if (activeJobs.length >= settings.maxConcurrentJobs) {
      return new Response(JSON.stringify({ 
        error: `You have reached the maximum of ${settings.maxConcurrentJobs} concurrent jobs. Please wait for some to complete.` 
      }), { 
        status: 429, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Check RunPod queue health
    try {
      const health = await getRunPodHealth(runpodConfig);
      const inQueueCount = health.jobs?.inQueue || 0;
      
      if (inQueueCount >= settings.maxQueueThreshold) {
        return new Response(JSON.stringify({ 
          error: `We're experiencing high demand right now (${inQueueCount} jobs queued). Please try again in a few minutes. We apologize for the inconvenience.`,
          queueFull: true
        }), { 
          status: 503, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    } catch (err) {
      console.error('[I2V] Failed to check RunPod health, proceeding anyway:', err);
      // Continue with job submission even if health check fails
    }

    await updateVideo(id, { status: 'in_queue', processing_started_at: new Date().toISOString() });

    // Use real I2V API endpoint
    // Build callback URL for webhook notification with video ID
    const origin = new URL(request.url).origin;
    const callbackUrl = `${origin}/api/i2v-webhook/${id}`;

    // Build the workflow from template with callback URL
    const payload = await buildWorkflow({
      image_name: `${id}.png`,
      image_url: existing.original_image_url,
      input_prompt: existing.prompt || 'A beautiful video',
      seed: Math.floor(Math.random() * 1000000),
      callback_url: callbackUrl
    });

    let jobId: string | undefined;
    try {
      const apiResult = await submitRunPodJob(runpodConfig, payload);
      
      // Record the job ID from the response
      if (apiResult.id) {
        jobId = apiResult.id;
        await updateVideo(id, { job_id: apiResult.id });
        console.log(`[I2V] Recorded job ID ${apiResult.id} for video ${id}`);
      }
    } catch (err) {
      console.error(`[I2V] Job submission failed:`, err);
      await updateVideo(id, { status: 'failed' });
      return new Response(
        JSON.stringify({ error: String(err) }), 
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ success: true, job_id: jobId }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[I2V] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
