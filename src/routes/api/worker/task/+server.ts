import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { claimLocalJob } from '$lib/db';

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
    
    // Return job details needed by the worker
    return new Response(
      JSON.stringify({
        id: job.id,
        job_id: job.job_id,
        original_image_url: job.original_image_url,
        prompt: job.prompt,
        tags: job.tags,
        is_photo_realistic: job.is_photo_realistic,
        is_nsfw: job.is_nsfw,
        processing_started_at: job.processing_started_at,
        // Workers should POST results to this callback URL
        callback_url: `${new URL(request.url).origin}/api/i2v-webhook/${job.id}`
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
