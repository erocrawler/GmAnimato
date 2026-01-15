import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById, getActiveJobCountByUser, getAdminSettings, checkDailyQuota, getLocalJobStats, getWorkflowById, getDefaultWorkflow, claimJobForMigration, isUserPaid } from '$lib/db';
import { env } from '$env/dynamic/private';
import { buildWorkflow } from '$lib/i2vWorkflow';
import { buildFL2VWorkflow } from '$lib/fl2vWorkflow';
import { getRunPodConfig, getRunPodHealth } from '$lib/runpod';
import { submitJob } from '$lib/local-queue';
import { filterLoraWeights } from '$lib/workflows';
import { toOriginalUrl } from '$lib/serverImageUrl';

async function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const body = await request.json();
    const id = body?.id as string | undefined;
    if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const existing = await getVideoById(id);
    if (!existing) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    // Check ownership (admins can kickoff any video)
    const isAdmin = locals.user?.roles?.includes('admin');
    if (existing.user_id !== locals.user.id && !isAdmin) {
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
    const allowedSteps = [4, 6] as const;
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
      // Detect if this is FL2V mode (has last_image_url) to get appropriate default
      const isFL2V = !!existing.last_image_url;
      const workflowType = isFL2V ? 'fl2v' : 'i2v';
      
      // Use default workflow for this type
      workflow = await getDefaultWorkflow(workflowType);
      if (!workflow) {
        return new Response(JSON.stringify({ error: `no default ${workflowType.toUpperCase()} workflow configured` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    console.log(`[I2V] Using workflow: ${workflow.name} (${workflow.id})`);

    // Detect if this is FL2V mode (has last_image_url)
    const isFL2V = !!existing.last_image_url;
    const expectedWorkflowType = isFL2V ? 'fl2v' : 'i2v';

    // Validate workflow type matches job type
    if (workflow.workflowType !== expectedWorkflowType) {
      return new Response(JSON.stringify({ 
        error: `Workflow type mismatch: Selected workflow "${workflow.name}" is for ${workflow.workflowType.toUpperCase()} jobs, but this is a ${expectedWorkflowType.toUpperCase()} job.` 
      }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

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

    // Enforce role requirement for 720p resolution
    if (resolution === '720p') {
      // Check if any of user's roles has allowAdvancedFeatures enabled
      const hasAdvancedFeatures = roles.some(roleName => 
        settings.roles?.find((rc: any) => rc.name === roleName)?.allowAdvancedFeatures
      );

      if (!hasAdvancedFeatures) {
        return new Response(JSON.stringify({ 
          error: '720p resolution is available to users with advanced features only.' 
        }), { 
          status: 403, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    // Enforce role requirement for 6 iteration steps
    if (iterationSteps === 6) {
      // Check if any of user's roles has allowAdvancedFeatures enabled
      const hasAdvancedFeatures = roles.some(roleName => 
        settings.roles?.find((rc: any) => rc.name === roleName)?.allowAdvancedFeatures
      );

      if (!hasAdvancedFeatures) {
        return new Response(JSON.stringify({ 
          error: '6 iteration steps is available to users with advanced features only.' 
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

    // Check per-user tier queue limit (free: 3, paid: 5)
    const activeJobCount = await getActiveJobCountByUser(existing.user_id);
    const isPaid = isUserPaid(locals.user, settings);
    const queueLimit = isPaid ? settings.paidUserQueueLimit : settings.freeUserQueueLimit;
    
    if (activeJobCount >= queueLimit) {
      return new Response(JSON.stringify({ 
        error: `You have reached your queue limit of ${queueLimit} jobs. Please wait for some to complete.` 
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

    if (!updated) {
      return new Response(JSON.stringify({ error: 'Failed to update video' }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    let jobId: string | undefined;
    let isLocal = false;
    try {
      // Use the new submitJob function with intelligent migration
      // All jobs go to local queue first, then oldest eligible jobs are migrated to RunPod
      const result = await submitJob(
        runpodConfig,
        updated,
        locals.user || null,
        settings,
        getLocalJobStats,
        claimJobForMigration,
        updateVideo,
        async (video) => {
          // This callback builds workflow for migrated jobs or RunPod-direct jobs
          const origin = new URL(request.url).origin;
          const callbackUrl = `${origin}/api/i2v-webhook/${video.id}`;
          
          // Check if this is FL2V workflow (has last_image_url)
          const isFL2VJob = !!video.last_image_url;
          
          if (isFL2VJob) {
            return await buildFL2VWorkflow({
              first_image_name: `${video.id}_first.png`,
              first_image_url: toOriginalUrl(video.original_image_url),
              last_image_name: `${video.id}_last.png`,
              last_image_url: toOriginalUrl(video.last_image_url!),
              input_prompt: video.prompt ?? 'A beautiful video',
              seed: video.seed ?? Math.floor(Math.random() * 1000000),
              callback_url: callbackUrl,
              iterationSteps: video.iteration_steps as any,
              videoDuration: video.video_duration as any,
              videoResolution: video.video_resolution as any,
              loraWeights: video.lora_weights as any,
              loraPresets: settings.loraPresets,
              workflow: (await getWorkflowById(video.workflow_id!) || await getDefaultWorkflow('fl2v'))!,
            });
          } else {
            return await buildWorkflow({
              image_name: `${video.id}.png`,
              image_url: toOriginalUrl(video.original_image_url),
              input_prompt: video.prompt ?? 'A beautiful video',
              seed: video.seed ?? Math.floor(Math.random() * 1000000),
              callback_url: callbackUrl,
              iterationSteps: video.iteration_steps as any,
              videoDuration: video.video_duration as any,
              videoResolution: video.video_resolution as any,
              loraWeights: video.lora_weights as any,
              loraPresets: settings.loraPresets,
              workflow: (await getWorkflowById(video.workflow_id!) || await getDefaultWorkflow('i2v'))!,
            });
          }
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
