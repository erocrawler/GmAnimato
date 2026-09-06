import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById, getActiveJobCountByUser, getAdminSettings, checkDailyQuota, getLocalJobStats, getWorkflowById, getDefaultWorkflow, claimJobForMigration, isUserPaid } from '$lib/db';
import { env } from '$env/dynamic/private';
import { buildJobWorkflow, getCallbackUrl } from '$lib/jobWorkflow';
import { getRunPodConfig, getRunPodHealth } from '$lib/runpod';
import { submitJob } from '$lib/local-queue';
import { filterLoraWeights, isMiniMaxWorkflow, getWorkflowCapabilities, getWorkflowEngine, getWorkflowRunOn } from '$lib/workflows';
import { computeWorkflowQuotaCost } from '$lib/quotaCost';
import { toOriginalUrl } from '$lib/serverImageUrl';
import { evaluatePromptProperties } from '$lib/imageRecognition';
import { maxAllowedDurationSeconds, MAX_DURATION_SECONDS_PAID } from '$lib/mediaLimits';

async function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function runDetachedRevalidation(videoId: string): Promise<void> {
  try {
    const current = await getVideoById(videoId);
    if (!current || current.status === 'deleted') {
      return;
    }

    const startedOptions = {
      ...(current.validation_metadata || {}),
      revalidation_status: 'processing' as const,
      revalidation_error: undefined,
    };

    await updateVideo(videoId, {
      validation_metadata: {
        ...startedOptions,
        revalidation_requested_at: current.validation_metadata?.revalidation_requested_at || new Date().toISOString(),
      },
    });

    const promptToEvaluate = (current.prompt || '').trim();
    if (!promptToEvaluate) {
      await updateVideo(videoId, {
        validation_metadata: {
          ...startedOptions,
          revalidation_status: 'failed',
          revalidation_completed_at: new Date().toISOString(),
          revalidation_error: 'missing_prompt',
        },
      });
      return;
    }

    const result = await evaluatePromptProperties(
      promptToEvaluate,
      toOriginalUrl(current.original_image_url),
      current.last_image_url ? toOriginalUrl(current.last_image_url) : undefined,
      current.user_id,
      videoId
    );

    if (result.is_photo_realistic === undefined && result.is_nsfw === undefined) {
      await updateVideo(videoId, {
        validation_metadata: {
          ...startedOptions,
          revalidation_status: 'failed',
          revalidation_completed_at: new Date().toISOString(),
          revalidation_error: 'provider_unavailable',
        },
      });
      return;
    }

    const patch: any = {
      validation_metadata: {
        ...startedOptions,
        revalidation_status: 'completed',
        revalidation_completed_at: new Date().toISOString(),
        revalidation_error: undefined,
      },
    };

    if (result.is_photo_realistic !== undefined) {
      patch.is_photo_realistic = result.is_photo_realistic;
    }
    if (result.is_nsfw !== undefined) {
      patch.is_nsfw = result.is_nsfw;
    }

    await updateVideo(videoId, patch);
  } catch (error) {
    console.error('[I2V] Detached revalidation failed:', error);
    const latest = await getVideoById(videoId);
    if (!latest) return;
    await updateVideo(videoId, {
      validation_metadata: {
        ...(latest.validation_metadata || {}),
        revalidation_status: 'failed',
        revalidation_completed_at: new Date().toISOString(),
        revalidation_error: String(error),
      },
    });
  }
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

    // Defensive: ref2v jobs require a non-empty prompt — the structured prompt
    // is the whole generation driver. Reject empty submissions here so a
    // browser-side contenteditable wipe can't silently queue a useless job.
    if (existing.additional_options?.ref2v === true) {
      const p = typeof prompt === 'string' ? prompt.trim() : '';
      if (!p) {
        return new Response(
          JSON.stringify({ error: 'ref2v requires a non-empty prompt', errorCode: 'empty_prompt' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const iterationStepsRaw = body?.iterationSteps;
    const parsedSteps = Number(iterationStepsRaw);
    const allowedSteps = [4, 6, 8] as const;
    type IterationSteps = (typeof allowedSteps)[number];
    let iterationSteps: IterationSteps = 4;

    if (Number.isFinite(parsedSteps) && allowedSteps.includes(parsedSteps as IterationSteps)) {
      iterationSteps = parsedSteps as IterationSteps;
    }

    // Extract video duration (4, 6, 10, or 15 seconds)
    const videoDurationRaw = body?.videoDuration;
    const parsedDuration = Number(videoDurationRaw);
    const allowedDurations = [4, 6, 10, MAX_DURATION_SECONDS_PAID] as const;
    type VideoDuration = (typeof allowedDurations)[number];
    let videoDuration: VideoDuration | undefined;

    // "Follow video duration" for ref2v: the client already resolved the output
    // duration to the ref video's length (clamped to the max allowed duration).
    // Accept any integer in that range instead of only the fixed presets, so
    // short refs (e.g. 5s) produce matching-length output.
    const ref2vFollowDuration: boolean = body?.ref2vFollowDuration === true;
    const isRef2vMode = existing.additional_options?.ref2v === true;

    if (Number.isFinite(parsedDuration) && parsedDuration >= 1 && parsedDuration <= MAX_DURATION_SECONDS_PAID) {
      if (allowedDurations.includes(parsedDuration as VideoDuration)) {
        videoDuration = parsedDuration as VideoDuration;
      } else if (ref2vFollowDuration && isRef2vMode) {
        videoDuration = Math.max(1, Math.min(MAX_DURATION_SECONDS_PAID, Math.round(parsedDuration))) as VideoDuration;
      }
    }

    // Extract video resolution (480p or 720p)
    const videoResolution = body?.videoResolution;
    const allowedResolutions = ['480p', '720p'] as const;
    type VideoResolution = (typeof allowedResolutions)[number];
    let resolution: VideoResolution | undefined;

    if (videoResolution && allowedResolutions.includes(videoResolution)) {
      resolution = videoResolution as VideoResolution;
    }

    // Extract ref2v aspect ratio (video / 16:9 / 4:3 / square / 3:4 / 9:16)
    const allowedAspects = ['video', '16:9', '4:3', 'square', '3:4', '9:16'] as const;
    type Ref2vAspect = (typeof allowedAspects)[number];
    let ref2vAspect: Ref2vAspect | undefined;
    if (body?.ref2vAspect && allowedAspects.includes(body.ref2vAspect)) {
      ref2vAspect = body.ref2vAspect as Ref2vAspect;
    }

    // Extract prompt relay mode params
    const promptRelayMode: boolean = body?.promptRelayMode === true;
    let promptRelaySegments: { prompt: string; frames: number }[] | undefined;
    if (promptRelayMode && Array.isArray(body?.promptRelaySegments)) {
      const rawSegs = body.promptRelaySegments as any[];
      // Validate and sanitize segments
      if (rawSegs.length < 1 || rawSegs.length > 10) {
        return new Response(JSON.stringify({ error: 'Prompt relay segments must be between 1 and 10' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      for (const seg of rawSegs) {
        if (typeof seg.frames !== 'number' || !Number.isInteger(seg.frames) || seg.frames < 9) {
          return new Response(JSON.stringify({ error: 'Each relay segment must have at least 9 frames (0.5s)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (seg.frames > 121) {
          return new Response(JSON.stringify({ error: 'Each relay segment must not exceed 121 frames' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (typeof seg.prompt !== 'string' || seg.prompt.trim().length === 0) {
          return new Response(JSON.stringify({ error: 'Each relay segment must have a non-empty prompt' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        if (seg.prompt.length > 500) {
          return new Response(JSON.stringify({ error: 'Each relay segment prompt must be at most 500 characters' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }
      promptRelaySegments = rawSegs.map(s => ({ prompt: String(s.prompt), frames: Number(s.frames) }));
    }

    // In relay mode, derive videoDuration from segment sum so it's stored correctly in the DB
    if (promptRelayMode && promptRelaySegments && promptRelaySegments.length > 0) {
      const rawSum = promptRelaySegments.reduce((s, seg) => s + seg.frames, 0);
      videoDuration = (rawSum <= 81 ? 4 : rawSum <= 121 ? 6 : 10) as VideoDuration;
    }

    // Extract motion scale (0.5 to 2.0) - optional experimental feature
    const motionScaleRaw = body?.motionScale;
    let motionScale: number | undefined;
    if (motionScaleRaw !== undefined && motionScaleRaw !== null) {
      const parsed = Number(motionScaleRaw);
      if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2.0) {
        motionScale = parsed;
      }
    }

    // Extract freeLong blend strength (0 to 1) - optional experimental feature
    const freeLongBlendStrengthRaw = body?.freeLongBlendStrength;
    let freeLongBlendStrength: number | undefined;
    if (freeLongBlendStrengthRaw !== undefined && freeLongBlendStrengthRaw !== null) {
      const parsed = Number(freeLongBlendStrengthRaw);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
        freeLongBlendStrength = parsed;
      }
    }

    // Get admin settings for thresholds
    const settings = await getAdminSettings();

    // Advanced-features entitlement — 720p, premium iteration steps, and the 6s
    // duration cap all key off this single flag.
    const roles = locals.user?.roles || [];
    const hasAdvancedFeatures = roles.some(roleName =>
      settings.roles?.find((rc: any) => rc.name === roleName)?.allowAdvancedFeatures
    );

    // Resolve workflow to use
    let workflow = null;
    if (workflowIdFromRequest) {
      workflow = await getWorkflowById(workflowIdFromRequest);
      if (!workflow) {
        return new Response(JSON.stringify({ error: 'workflow not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    } else {
      // Detect if this is FL2V mode (has last_image_url) or ref2v (additional_options.ref2v)
      const isFL2V = !!existing.last_image_url;
      const isRef2V = existing.additional_options?.ref2v === true;
      const workflowType = isRef2V ? 'ref2v' : isFL2V ? 'fl2v' : 'i2v';
      
      // Use default workflow for this type
      workflow = await getDefaultWorkflow(workflowType);
      if (!workflow) {
        return new Response(JSON.stringify({ error: `no default ${workflowType.toUpperCase()} workflow configured` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    console.log(`[I2V] Using workflow: ${workflow.name} (${workflow.id})`);

    // Detect if this is FL2V mode (has last_image_url) or ref2v (additional_options.ref2v)
    const isFL2V = !!existing.last_image_url;
    const isRef2V = existing.additional_options?.ref2v === true;
    const expectedWorkflowType = isRef2V ? 'ref2v' : isFL2V ? 'fl2v' : 'i2v';

    // Validate workflow type matches job type
    if (workflow.workflowType !== expectedWorkflowType) {
      return new Response(JSON.stringify({ 
        error: `Workflow type mismatch: Selected workflow "${workflow.name}" is for ${workflow.workflowType.toUpperCase()} jobs, but this is a ${expectedWorkflowType.toUpperCase()} job.` 
      }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // ---- Workflow capability allowlists (steps / durations / resolutions) ----
    // The selected workflow (or its engine defaults) defines what this model can
    // run. Reject explicit out-of-range values and clamp anything ambiguous.
    const caps = getWorkflowCapabilities(workflow);
    const engine = getWorkflowEngine(workflow);
    const capMaxDuration = Math.max(...caps.durations);
    const stepExplicit = body && Object.prototype.hasOwnProperty.call(body, 'iterationSteps');
    const durationExplicit = body && Object.prototype.hasOwnProperty.call(body, 'videoDuration');
    const resolutionExplicit = body && Object.prototype.hasOwnProperty.call(body, 'videoResolution');

    if (stepExplicit && !(caps.steps as readonly number[]).includes(iterationSteps)) {
      return new Response(JSON.stringify({
        error: `${iterationSteps} iteration steps is not available for the selected model (${workflow.name}). Allowed: ${caps.steps.join(' / ')}.`
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (!(caps.steps as readonly number[]).includes(iterationSteps)) {
      // Implicit/legacy value not in the allowlist — snap to the engine default
      // when present, else the cheapest allowed step.
      iterationSteps = ((caps.steps as readonly number[]).includes(engine === 'minimax' ? 8 : 4)
        ? (engine === 'minimax' ? 8 : 4)
        : caps.steps[0] ?? 4) as IterationSteps;
    }

    if (videoDuration !== undefined) {
      const isPreset = (caps.durations as readonly number[]).includes(videoDuration);
      const isFollow = ref2vFollowDuration && isRef2vMode;
      if (!isPreset && !(isFollow && videoDuration >= 1 && videoDuration <= capMaxDuration)) {
        if (durationExplicit) {
          return new Response(JSON.stringify({
            error: `${videoDuration}-second duration is not available for the selected model (${workflow.name}). Allowed: ${caps.durations.join('s / ')}s.`
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        videoDuration = Math.min(videoDuration, capMaxDuration) as VideoDuration;
      }
      // Clamp follow/edge durations to the workflow's max option too.
      if (videoDuration > capMaxDuration) {
        videoDuration = capMaxDuration as VideoDuration;
      }
    }

    if (resolution !== undefined && !caps.resolutions.includes(resolution)) {
      if (resolutionExplicit) {
        return new Response(JSON.stringify({
          error: `${resolution} is not available for the selected model (${workflow.name}). Allowed: ${caps.resolutions.join(' / ')}.`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      resolution = '480p';
    }

    // Max (15s) duration is a MiniMax H3-only option
    if (videoDuration === MAX_DURATION_SECONDS_PAID && !isMiniMaxWorkflow(workflow)) {
      return new Response(JSON.stringify({
        error: `${MAX_DURATION_SECONDS_PAID}-second duration is only available with the MiniMax H3 model.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Cap output duration at the tier's max allowed duration (6s free / 15s
    // advanced). ref2v "follow video duration" on a long ref is clamped rather
    // than rejected; relay mode is capped separately via the frame-count check
    // below. maxAllowedDuration is 6 or 15 — both valid VideoDuration values.
    const maxAllowedDuration = maxAllowedDurationSeconds(hasAdvancedFeatures);
    if (videoDuration !== undefined && videoDuration > maxAllowedDuration && !promptRelayMode) {
      videoDuration = maxAllowedDuration;
    }

    // Filter LoRA weights to only compatible ones for the selected workflow
    const filteredLoraWeights = loraWeights ? filterLoraWeights(loraWeights, workflow) : undefined;

    // Generate seed for reproducibility
    const seed = Math.floor(Math.random() * 1000000);

    const hasManualRecognition = existing.validation_metadata?.manual_recognition_done === true;
    // Revalidate when analysis has not been done yet (to establish baseline),
    // or when prior analysis marked image as SFW (prompt edits can introduce NSFW intent).
    // Skip only if prior result is already NSFW and manual analysis exists.
    const shouldRevalidate = !hasManualRecognition || existing.is_nsfw === false;
    const mergedAdditionalOptions: any = {
      ...(existing.additional_options || {}),
    };

    if (ref2vAspect === undefined) {
      delete mergedAdditionalOptions.ref2v_aspect;
    } else {
      mergedAdditionalOptions.ref2v_aspect = ref2vAspect;
    }
    if (isRef2vMode) {
      mergedAdditionalOptions.ref2v_follow_duration = ref2vFollowDuration;
    } else {
      delete mergedAdditionalOptions.ref2v_follow_duration;
    }
    const mergedValidationMetadata: any = {
      ...(existing.validation_metadata || {}),
    };

    if (motionScale === undefined) {
      delete mergedAdditionalOptions.motion_scale;
    } else {
      mergedAdditionalOptions.motion_scale = motionScale;
    }

    if (freeLongBlendStrength === undefined) {
      delete mergedAdditionalOptions.freelong_blend_strength;
    } else {
      mergedAdditionalOptions.freelong_blend_strength = freeLongBlendStrength;
    }

    // Store relay mode state
    mergedAdditionalOptions.prompt_relay_mode = promptRelayMode;
    if (promptRelayMode && promptRelaySegments) {
      mergedAdditionalOptions.prompt_relay_segments = promptRelaySegments;
    } else {
      delete mergedAdditionalOptions.prompt_relay_segments;
    }

    if (shouldRevalidate) {
      mergedValidationMetadata.revalidation_status = 'pending';
      mergedValidationMetadata.revalidation_requested_at = new Date().toISOString();
      delete mergedValidationMetadata.revalidation_completed_at;
      delete mergedValidationMetadata.revalidation_error;
    }

    // Save user's settings first (before quota check) so their preferences are preserved
    // Snapshot the workflow's effective credit cost so historical usage stays accurate
    // even if the workflow is later edited or deleted. The cost is computed from the
    // base quotaCost plus any matching quotaCostRules (e.g. 2x if duration >= 8s or
    // if a speed-up LoRA is not used).
    const workflowQuotaCost = computeWorkflowQuotaCost(workflow, {
      videoDuration,
      videoResolution: resolution,
      loraWeights: filteredLoraWeights,
    });
    const settingsPayload: any = { 
      workflow_id: workflow.id,
      quota_cost: workflowQuotaCost,
      iteration_steps: iterationSteps,
      video_duration: videoDuration,
      video_resolution: resolution,
      validation_metadata: mergedValidationMetadata,
      additional_options: mergedAdditionalOptions,
      lora_weights: filteredLoraWeights,
      seed: seed
    };
    
    if (prompt !== undefined) {
      settingsPayload.prompt = prompt;
    }
    
    if (tags !== undefined) {
      settingsPayload.tags = tags;
    }

    const saved = await updateVideo(id, settingsPayload);
    // updateVideo now re-throws on DB errors, but guard defensively anyway: if
    // it ever returns null (or a row without the prompt we just wrote), abort
    // BEFORE queuing — otherwise the job gets queued with an unsaved/empty
    // prompt and the user sees a false success.
    if (!saved || (prompt !== undefined && (saved as any)?.prompt !== prompt)) {
      throw new Error('Failed to persist video settings (prompt not saved)');
    }

    // Check daily quota if user is logged in (in credits — cost may be > 1)
    if (locals.user) {
      const quotaCheck = await checkDailyQuota(locals.user, settings, workflowQuotaCost);
      if (quotaCheck.exceeded) {
        const errorCode = quotaCheck.limit === 0 ? 'quota_none' : 'quota_exceeded';
        return new Response(JSON.stringify({ 
          error: `This video costs ${workflowQuotaCost} credit${workflowQuotaCost > 1 ? 's' : ''}. You have used ${quotaCheck.used} of your ${quotaCheck.limit} daily credits.`,
          errorCode,
          limit: quotaCheck.limit,
          used: quotaCheck.used,
          cost: workflowQuotaCost,
        }), { 
          status: 429, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    // Enforce role requirement for 720p resolution
    if (resolution === '720p' && !hasAdvancedFeatures) {
      return new Response(JSON.stringify({ 
        error: '720p resolution is available to users with advanced features only.' 
      }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Enforce role requirement for premium iteration steps. A step is premium
    // when it's above THIS workflow's freeSteps (per-workflow, default 4) — so
    // a turbo workflow that raises freeSteps to 8 lets free users run its 8 NFE.
    const isPremiumStep = iterationSteps > caps.freeSteps;
    if (isPremiumStep && !hasAdvancedFeatures) {
      return new Response(JSON.stringify({ 
        error: `${iterationSteps} iteration steps is available to users with advanced features only.` 
      }), { 
        status: 403, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Validate relay segment frame total: must be 4n+1, at least 81, within tier limit
    if (promptRelayMode && promptRelaySegments) {
      const totalSegmentFrames = promptRelaySegments.reduce((sum, s) => sum + s.frames, 0);
      if (totalSegmentFrames < 81 || (totalSegmentFrames - 1) % 4 !== 0) {
        return new Response(JSON.stringify({
          error: `Total relay frames (${totalSegmentFrames}) must be a value of 4n+1 and at least 81 (e.g. 81, 85, 89 … 121 … 177)`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const maxAllowedFrames = hasAdvancedFeatures ? 177 : 121;
      if (totalSegmentFrames > maxAllowedFrames) {
        return new Response(JSON.stringify({
          error: `Total relay frames (${totalSegmentFrames}) exceeds the maximum of ${maxAllowedFrames} for your account tier.`
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

    // Serverless-only workflows must never fall through to the local queue.
    // If RunPod isn't configured we can't honor that — fail loudly instead of
    // silently running the model on a worker that doesn't have its weights.
    const workflowRunOn = getWorkflowRunOn(workflow);
    if (workflowRunOn === 'serverless' && !runpodConfig) {
      return new Response(JSON.stringify({
        error: `This model (${workflow.name}) is only available on the serverless endpoint, which is not configured.`
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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
        error: `You have reached your queue limit of ${queueLimit} jobs. Please wait for some to complete.`,
        errorCode: 'queue_limit',
        limit: queueLimit,
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
        workflowRunOn,
        async (video) => {
          // This callback builds workflow for migrated jobs or RunPod-direct jobs.
          // Single shared construction path (MiniMax / FL2V / I2V / Ref2V) —
          // see src/lib/jobWorkflow.ts
          const origin = new URL(request.url).origin;
          // Always include the callback (CALLBACK_BASE_URL override supported).
          const callbackUrl = getCallbackUrl(origin, video.id);

          const { payload } = await buildJobWorkflow({
            video,
            settings,
            callbackUrl,
            useSageAttention: env.ENABLE_SAGE_ATTENTION_RUNPOD === 'true',
          });

          return payload;
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

    if (shouldRevalidate) {
      void runDetachedRevalidation(id);
    }

    return new Response(
      JSON.stringify({ success: true, job_id: jobId, is_local: isLocal, video: finalVideo }), 
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[I2V] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
