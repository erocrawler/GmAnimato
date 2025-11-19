import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById } from '$lib/db';
import { env } from '$env/dynamic/private';

// Set your webhook secret here or load from env
const WEBHOOK_SECRET = env.WEBHOOK_SECRET || 'dev-webhook-secret';

export const POST: RequestHandler = async ({ request, url }) => {
  try {
    // Check for webhook token in query parameter
    const token = url.searchParams.get('token');
    if (token !== WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const id = body?.id as string | undefined;
    const status = body?.status as string | undefined;
    const final_video_url = body?.final_video_url as string | undefined;

    if (!id || !status) return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    console.log(`[Webhook] Received callback for ${id}, status: ${status}, video_url: ${final_video_url}`);

    const existing = await getVideoById(id);
    if (!existing) {
      console.error(`[Webhook] Video ${id} not found`);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    console.log(`[Webhook] Current status for ${id}: ${existing.status}`);

    const patch: any = { status };
    if (final_video_url) patch.final_video_url = final_video_url;

    console.log(`[Webhook] Updating ${id} with patch:`, patch);
    const updated = await updateVideo(id, patch);
    console.log(`[Webhook] Update result for ${id}:`, updated);

    return new Response(JSON.stringify({ success: true, updated }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};