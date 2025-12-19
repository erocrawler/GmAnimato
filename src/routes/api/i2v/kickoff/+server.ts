import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById, getActiveJobsByUser, getAdminSettings, checkDailyQuota, getLocalJobStats, getWorkflowById, getDefaultWorkflow } from '$lib/db';
import { env } from '$env/dynamic/private';
import { buildWorkflow } from '$lib/i2vWorkflow';
import { getRunPodConfig, getRunPodHealth } from '$lib/runpod';
import { submitJob } from '$lib/local-queue';
import { filterLoraWeights } from '$lib/workflows';

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

    // Check ownership (admins can kickoff any video)
    const isAdmin = locals.user?.roles?.includes('admin');
    if (locals.user && existing.user_id !== locals.user.id && !isAdmin) {
      return new Response(JSON.stringify({ error: 'access denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    if (existing.status === 'processing' || existing.status === 'in_queue') {
      return new Response(JSON.stringify({ error: 'already processing' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Extract prompt, tags, workflowId, and optional LoRA weights from request body
    const prompt = body?.prompt;
    const tags = body?.tags;
    const workflowIdFromRequest = body?.workflowId;
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

    // Resolve workflow to use
    let workflow = null;
    if (workflowIdFromRequest) {
      workflow = await getWorkflowById(workflowIdFromRequest);
      if (!workflow) {
        return new Response(JSON.stringify({ error: 'workflow not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    } else {
      // Use default workflow
      workflow = await getDefaultWorkflow();
      if (!workflow) {
        return new Response(JSON.stringify({ error: 'no default workflow configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    console.log(`[I2V] Using workflow: ${workflow.name} (${workflow.id})`);

    // Filter LoRA weights to only compatible ones for the selected workflow
    const filteredLoraWeights = loraWeights ? filterLoraWeights(loraWeights, workflow) : undefined;

    // Generate seed for reproducibility
    const seed = Math.floor(Math.random() * 1000000);

    // Save user's settings first (before quota check) so their preferences are preserved
    const settingsPayload: any = { 
      workflow_id: workflow.id,
      iteration_steps: iterationSteps,
      video_duration: videoDuration,
      video_resolution: resolution,
      lora_weights: filteredLoraWeights,
      seed: seed
    };
    
    if (prompt !== undefined) {
      settingsPayload.prompt = prompt;
    }
    
    if (tags !== undefined) {
      settingsPayload.tags = tags;
    }

    await updateVideo(id, settingsPayload);

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

    // Determine RunPod and local queue availability
    const runpodConfig = getRunPodConfig({
      RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL,
      RUNPOD_API_KEY: env.RUNPOD_API_KEY
    });

    let localQueueAvailable = false;
    try {
      const stats = await getLocalJobStats();
      localQueueAvailable = Number.isFinite(stats.inQueue);
    } catch (e) {
      localQueueAvailable = false;
    }

    if (!runpodConfig && !localQueueAvailable) {
      // Fall back to mock I2V workflow only if neither local nor RunPod is configured
      console.log(`[Mock I2V] Neither local queue nor RunPod configured, using mock workflow`);
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

    // Check RunPod queue health only if RunPod is configured
    if (runpodConfig) {
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
    }

    // Update video status to in_queue and set processing start time
    await updateVideo(id, { 
      status: 'in_queue', 
      processing_started_at: new Date().toISOString()
    });

    // Verify the update by fetching the video again
    const updated = await getVideoById(id);
    console.log(`[I2V] Video ${id} status after update: ${updated?.status}`);

    let jobId: string | undefined;
    let isLocal = false;
    try {
      // Use the new submitJob function that routes to local or RunPod
      // For local jobs, workflow will be built on-demand by /api/worker/task
      // For RunPod jobs, we need to build the workflow now
      const result = await submitJob(
        runpodConfig, 
        id, 
        settings.localQueueThreshold, 
        getLocalJobStats, 
        updateVideo,
        async () => {
          // This callback is only called if routing to RunPod
          const origin = new URL(request.url).origin;
          const callbackUrl = `${origin}/api/i2v-webhook/${id}`;
          
          return await buildWorkflow({
            image_name: `${id}.png`,
            image_url: existing.original_image_url,
            input_prompt: prompt ?? existing.prompt ?? 'A beautiful video',
            seed: seed,
            callback_url: callbackUrl,
            iterationSteps,
            videoDuration,
            videoResolution: resolution,
            loraWeights: filteredLoraWeights,
            loraPresets: settings.loraPresets,
            workflow: workflow,
          });
        }
      );
      jobId = result.jobId;
      isLocal = result.isLocal;
      
      console.log(`[I2V] Submitted job ${jobId} for video ${id} (local: ${isLocal})`);
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
      JSON.stringify({ success: true, job_id: jobId, is_local: isLocal, video: finalVideo }), 
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[I2V] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
