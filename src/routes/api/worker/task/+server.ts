import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { claimLocalJob, getAdminSettings, updateVideo } from '$lib/db';
import { buildJobWorkflow, getCallbackUrl } from '$lib/jobWorkflow';

/**
 * GET /api/worker/task
 * Returns the oldest pending local job for processing by a worker
 * The worker should process this task and POST to /api/i2v-webhook/[id] when complete
 * 
 * Uses atomic database operations to prevent race conditions when multiple workers
 * are polling for tasks simultaneously.
 */
export const GET: RequestHandler = async ({ request }) => {
  // Track the job we claimed so that if workflow construction fails after the
  // claim we can fail the job instead of leaving it stuck in 'processing'
  // (no task is delivered, so no worker will ever send a webhook for it).
  let claimedJob: Awaited<ReturnType<typeof claimLocalJob>> = null;
  try {
    const workerSecret = env.WORKER_TASK_SECRET;
    if (!workerSecret) {
      return new Response(
        JSON.stringify({ error: 'Worker secret not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const provided = (request.headers.get('x-worker-secret') ?? request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!provided || provided !== workerSecret) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Optionally scope the claim to a specific user's jobs.
    // The user can be passed via the 'x-worker-user-id' header or a 'userId' query param.
    const { searchParams } = new URL(request.url);
    const requestedUserId = request.headers.get('x-worker-user-id') ?? searchParams.get('userId') ?? undefined;

    // Worker-declared capabilities (comma-separated, e.g. 'sage_attention').
    // When a worker declares its capabilities, the server trusts it — a worker
    // that can't run sage attention must not receive a workflow that requires
    // it. When no capabilities are declared, fall back to the env default.
    const declaredCapabilities = (request.headers.get('x-worker-capabilities') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    let useSageAttention = env.ENABLE_SAGE_ATTENTION_LOCAL === 'true';
    if (declaredCapabilities.length > 0) {
      if (declaredCapabilities.includes('sage_attention') || declaredCapabilities.includes('sage-attention')) {
        useSageAttention = true;
      } else {
        // Declared capabilities without sage attention (or an unknown set) —
        // be conservative and disable it rather than send an unrunnable job.
        useSageAttention = false;
      }
      console.log(`[Worker] Capabilities declared: [${declaredCapabilities.join(', ')}] → sage attention: ${useSageAttention}`);
    } else {
      console.log(`[Worker] No capabilities declared, using env default (sage attention: ${useSageAttention})`);
    }

    // Atomically claim the oldest local job in the queue
    // This prevents race conditions where two workers claim the same job
    const job = await claimLocalJob(requestedUserId);
    
    if (!job) {
      return new Response(
        JSON.stringify({ message: 'No tasks available' }), 
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    claimedJob = job;
    
    console.log(`[Worker] Assigned task ${job.id} to worker (status automatically set to processing)${requestedUserId ? ` [user: ${requestedUserId}]` : ''}`);
    
    // Build the workflow for this job
    const settings = await getAdminSettings();
    const { origin: workerOrigin } = new URL(request.url);
    // Always include the callback: the worker just reached this origin to fetch
    // the task, so it can reach the webhook too. (CALLBACK_BASE_URL override
    // supported for tunneled/remote setups via getCallbackUrl.)
    const callbackUrl = getCallbackUrl(workerOrigin, job.id);
    
    // Detect workflow type from job (for logging; actual build in jobWorkflow)
    const isRef2V = job.additional_options?.ref2v === true;
    const isFL2V = !!job.last_image_url;
    const workflowType = isRef2V ? 'ref2v' : isFL2V ? 'fl2v' : 'i2v';

    const imageInputMode = (env.WORKER_IMAGE_INPUT_MODE ?? 'base64').toLowerCase();
    const shouldSendBase64 = imageInputMode !== 'url';

    // Build the workflow payload using the single shared construction path
    // (Ref2V / MiniMax / FL2V / I2V) — see src/lib/jobWorkflow.ts
    const { workflow: resolvedWorkflow, payload } = await buildJobWorkflow({
      video: job,
      settings,
      callbackUrl,
      imageMode: shouldSendBase64 ? 'base64' : 'url',
      useSageAttention,
    });

    console.log(`[Worker] Using workflow: ${resolvedWorkflow.name} (${resolvedWorkflow.id}) for ${workflowType.toUpperCase()} job ${job.id}`);
    
    // Return the complete workflow payload for the worker
    // payload already contains everything: { input: { workflow: {...}, images: [...], callback_url: ... } }
    return new Response(
      JSON.stringify({
        id: job.job_id,
        ...payload
      }), 
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Worker] Error fetching task:', err);
    // If we already claimed a job, the task will never be delivered to a worker
    // (the 500 response means the worker got nothing), so no webhook will ever
    // arrive for it. Mark it failed so it doesn't sit in 'processing' until the
    // processing timeout kicks in.
    if (claimedJob) {
      try {
        await updateVideo(claimedJob.id, { status: 'failed' });
        console.error(`[Worker] Marked job ${claimedJob.id} failed after task build error`);
      } catch (markErr) {
        console.error(`[Worker] Failed to mark job ${claimedJob.id} failed:`, markErr);
      }
    }
    return new Response(
      JSON.stringify({ error: String(err) }), 
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
