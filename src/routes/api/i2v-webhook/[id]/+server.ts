import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById } from '$lib/db';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing video id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const job_id = body?.id as string | undefined; // handler.py sends 'id' not 'job_id'
    const status = body?.status as string | undefined;
    const files = body?.files as any[] | undefined;

    if (!job_id || !status) {
      return new Response(JSON.stringify({ error: 'missing id or status' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    console.log(`[Webhook] Received callback for video ${id}, job_id: ${job_id}, status: ${status}, files count: ${files?.length || 0}`);

    const existing = await getVideoById(id);
    if (!existing) {
      console.error(`[Webhook] Video ${id} not found`);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify job_id matches (skip for mock jobs)
    if (existing.job_id && job_id !== 'mock-job-id' && existing.job_id !== job_id) {
      console.error(`[Webhook] Job ID mismatch for video ${id}. Expected: ${existing.job_id}, Got: ${job_id}`);
      return new Response(JSON.stringify({ error: 'job_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    console.log(`[Webhook] Job ID verified for video ${id}. Current status: ${existing.status}`);

    const patch: any = { status };
    
    // Extract video URL from files array if present
    if (files && Array.isArray(files)) {
      const videoFile = files.find(file => 
        file.type === 's3_url' && 
        file.filename && 
        (file.filename.endsWith('.mp4') || file.filename.endsWith('.webm'))
      );
      if (videoFile?.data) {
        patch.final_video_url = videoFile.data;
        console.log(`[Webhook] Extracted video URL from files: ${videoFile.data}`);
      }
    }

    console.log(`[Webhook] Updating ${id} with patch:`, patch);
    const updated = await updateVideo(id, patch);
    console.log(`[Webhook] Update result for ${id}:`, updated);

    return new Response(JSON.stringify({ success: true, updated }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};