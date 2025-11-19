import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById } from '$lib/db';
import { env } from '$env/dynamic/private';
import { buildWorkflow } from '$lib/i2vWorkflow';

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

    await updateVideo(id, { status: 'in_queue' });

    // Check if real API endpoint is configured
    const VIDEO_ENDPOINT_URL = env.VIDEO_ENDPOINT_URL;
    const VIDEO_ENDPOINT_API_KEY = env.VIDEO_ENDPOINT_API_KEY;

    if (!VIDEO_ENDPOINT_URL || !VIDEO_ENDPOINT_API_KEY) {
      // Fall back to mock I2V workflow
      console.log(`[Mock I2V] VIDEO_ENDPOINT_URL or VIDEO_ENDPOINT_API_KEY not configured, using mock workflow`);
      const origin = new URL(request.url).origin;
      (async () => {
        console.log(`[Mock I2V] Starting background job for ${id} at ${origin}`);
        await delay(1500); // simulate work
        try {
          console.log(`[Mock I2V] Sending webhook for ${id} to ${origin}/api/i2v-webhook`);
          const res = await fetch(`${origin}/api/i2v-webhook?token=${env.WEBHOOK_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status: 'completed', final_video_url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' })
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

    // Use real I2V API endpoint
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET;

    // Build callback URL for webhook notification
    const origin = new URL(request.url).origin;
    const callbackUrl = `${origin}/api/i2v-webhook?token=${WEBHOOK_SECRET}`;

    // Build the workflow from template with callback URL
    const payload = await buildWorkflow({
      image_name: `${id}.png`,
      image_url: existing.original_image_url,
      input_prompt: existing.prompt || 'A beautiful video',
      seed: Math.floor(Math.random() * 1000000),
      callback_url: callbackUrl
    });

    console.log(`[I2V] Sending request for ${id} to ${VIDEO_ENDPOINT_URL}`);
    const apiResponse = await fetch(VIDEO_ENDPOINT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VIDEO_ENDPOINT_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(`[I2V] API request failed: ${apiResponse.status} - ${errorText}`);
      await updateVideo(id, { status: 'failed' });
      return new Response(
        JSON.stringify({ error: `API request failed: ${apiResponse.status}` }), 
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apiResult = await apiResponse.json();
    console.log(`[I2V] API request successful for ${id}`, apiResult);

    // Record the job ID from the response
    if (apiResult.id) {
      await updateVideo(id, { job_id: apiResult.id });
      console.log(`[I2V] Recorded job ID ${apiResult.id} for video ${id}`);
    }

    return new Response(JSON.stringify({ success: true, job_id: apiResult.id }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[I2V] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
