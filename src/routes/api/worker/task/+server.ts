import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { claimLocalJob, getAdminSettings, getWorkflowById, getDefaultWorkflow } from '$lib/db';
import { buildWorkflow } from '$lib/i2vWorkflow';

/**
 * GET /api/worker/task
 * Returns the oldest pending local job for processing by a worker
 * The worker should process this task and POST to /api/i2v-webhook/[id] when complete
 * 
 * Uses atomic database operations to prevent race conditions when multiple workers
 * are polling for tasks simultaneously.
 */
export const GET: RequestHandler = async ({ request }) => {
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

    // Atomically claim the oldest local job in the queue
    // This prevents race conditions where two workers claim the same job
    const job = await claimLocalJob();
    
    if (!job) {
      return new Response(
        JSON.stringify({ message: 'No tasks available' }), 
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`[Worker] Assigned task ${job.id} to worker (status automatically set to processing)`);
    
    // Build the workflow for this job
    const settings = await getAdminSettings();
    const callbackUrl = `${new URL(request.url).origin}/api/i2v-webhook/${job.id}`;
    
    // Resolve workflow to use
    let workflow = null;
    if (job.workflow_id) {
      workflow = await getWorkflowById(job.workflow_id);
    }
    if (!workflow) {
      workflow = await getDefaultWorkflow();
    }
    if (!workflow) {
      return new Response(
        JSON.stringify({ error: 'No workflow configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const payload = await buildWorkflow({
      image_name: `${job.id}.png`,
      image_url: job.original_image_url,
      input_prompt: job.prompt ?? 'A beautiful video',
      seed: job.seed ?? Math.floor(Math.random() * 1000000),
      callback_url: callbackUrl,
      iterationSteps: job.iteration_steps as 4 | 6 | 8 | undefined,
      videoDuration: job.video_duration as 4 | 6 | undefined,
      videoResolution: job.video_resolution as '480p' | '720p' | undefined,
      loraWeights: typeof job.lora_weights === 'object' && job.lora_weights !== null ? job.lora_weights as Record<string, number> : undefined,
      loraPresets: settings.loraPresets,
      workflow: workflow,
    });
    
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
    return new Response(
      JSON.stringify({ error: String(err) }), 
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
