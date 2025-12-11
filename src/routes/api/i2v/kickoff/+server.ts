import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById, getActiveJobsByUser, getAdminSettings, checkDailyQuota } from '$lib/db';
import { env } from '$env/dynamic/private';
import { buildWorkflow } from '$lib/i2vWorkflow';
import { getRunPodConfig, submitRunPodJob, getRunPodHealth } from '$lib/runpod';

async function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const id = body?.id as string | undefined;
    if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const existing = await getVideoById(id);
    if (!existing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    if (existing.status === 'processing' || existing.status === 'in_queue') {
      return new Response(JSON.stringify({ error: 'already processing' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Extract prompt, tags, and optional LoRA weights from request body
    const prompt = body?.prompt;
    const tags = body?.tags;
    const loraWeights = body?.loraWeights;
    const iterationStepsRaw = body?.iterationSteps;
    const parsedSteps = Number(iterationStepsRaw);
    const allowedSteps = [4, 6, 8] as const;
    type IterationSteps = (typeof allowedSteps)[number];
    let iterationSteps: IterationSteps = 4;

    if (Number.isFinite(parsedSteps) && allowedSteps.includes(parsedSteps as IterationSteps)) {
      iterationSteps = parsedSteps as IterationSteps;
    }

    // Extract video duration (4 or 6 seconds)
    const videoDurationRaw = body?.videoDuration;
    const parsedDuration = Number(videoDurationRaw);
    const allowedDurations = [4, 6] as const;
    type VideoDuration = (typeof allowedDurations)[number];
    let videoDuration: VideoDuration | undefined;

    if (Number.isFinite(parsedDuration) && allowedDurations.includes(parsedDuration as VideoDuration)) {
      videoDuration = parsedDuration as VideoDuration;
    }

    // Extract video resolution (480p or 720p)
    const videoResolution = body?.videoResolution;
    const allowedResolutions = ['480p', '720p'] as const;
    type VideoResolution = (typeof allowedResolutions)[number];
    let resolution: VideoResolution | undefined;

    if (videoResolution && allowedResolutions.includes(videoResolution)) {
      resolution = videoResolution as VideoResolution;
    }

    // Get admin settings for thresholds
    const settings = await getAdminSettings();

    // Check daily quota if user is logged in
    if (locals.user) {
      const quotaCheck = await checkDailyQuota(locals.user, settings);
      if (quotaCheck.exceeded) {
        return new Response(JSON.stringify({ 
          error: `You have reached your daily limit of ${quotaCheck.limit} videos. You've created ${quotaCheck.used} videos today. Please try again tomorrow.` 
        }), { 
          status: 429, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    // Get user roles for feature enforcement
    const roles = locals.user?.roles || [];

    // Enforce role requirement for detailed (8-step) runs
    if (iterationSteps === 8) {
      if (!roles.includes('paid-user')) {
        return new Response(JSON.stringify({ 
          error: 'Detailed mode (8 steps) is available to paid users only.' 
        }), { 
          status: 403, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    // Enforce role requirement for 720p resolution
    if (resolution === '720p') {
      if (!roles.includes('paid-user')) {
        return new Response(JSON.stringify({ 
          error: '720p resolution is available to paid users only.' 
        }), { 
          status: 403, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

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

    // Update video with status, prompt, tags, and processing start time
    const updatePayload: any = { 
      status: 'in_queue', 
      processing_started_at: new Date().toISOString() 
    };
    
    if (prompt !== undefined) {
      updatePayload.prompt = prompt;
    }
    
    if (tags !== undefined) {
      updatePayload.tags = tags;
    }

    await updateVideo(id, updatePayload);

    // Verify the update by fetching the video again
    const updated = await getVideoById(id);
    console.log(`[I2V] Video ${id} status after update: ${updated?.status}`);

    // Use real I2V API endpoint
    // Build callback URL for webhook notification with video ID
    const origin = new URL(request.url).origin;
    const callbackUrl = `${origin}/api/i2v-webhook/${id}`;

    // Build the workflow from template with callback URL
    const payload = await buildWorkflow({
      image_name: `${id}.png`,
      image_url: existing.original_image_url,
      input_prompt: prompt ?? existing.prompt ?? 'A beautiful video',
      seed: Math.floor(Math.random() * 1000000),
      callback_url: callbackUrl,
      iterationSteps,
      videoDuration,
      videoResolution: resolution,
      loraWeights: typeof loraWeights === 'object' && loraWeights !== null ? loraWeights : undefined,
      loraPresets: settings.loraPresets,
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

    // Return the updated video status
    const finalVideo = await getVideoById(id);
    return new Response(
      JSON.stringify({ success: true, job_id: jobId, video: finalVideo }), 
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[I2V] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
