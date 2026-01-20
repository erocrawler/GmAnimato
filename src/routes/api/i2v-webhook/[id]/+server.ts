import type { RequestHandler } from '@sveltejs/kit';
import { updateVideo, getVideoById } from '$lib/db';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';
import { uploadBufferToS3 } from '$lib/s3';
import { toProxiedUrl } from '$lib/serverImageUrl';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing video id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const webhook_job_id = body?.id as string | undefined; // handler.py sends video id in 'id' field
    const status = body?.status as string | undefined;
    const files = body?.files as any[] | undefined;

    if (!webhook_job_id || !status) {
      return new Response(JSON.stringify({ error: 'missing id or status' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const existing = await getVideoById(id);
    if (!existing) {
      console.error(`[Webhook] Video ${id} not found`);
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the webhook is for this video
    if (webhook_job_id !== existing.job_id) {
      console.error(`[Webhook] Job ID mismatch for job. Expected: ${existing.job_id}, got: ${webhook_job_id}`);
      return new Response(JSON.stringify({ error: 'job id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const patch: any = { status: status.toLowerCase() };
    
    // Set dequeued_at when transitioning to processing
    if (patch.status === 'processing' && existing.status !== 'processing' && !existing.dequeued_at) {
      patch.dequeued_at = new Date().toISOString();
    }
    
    // Handle progress updates
    const progress = body?.progress as any | undefined;
    if (progress && typeof progress === 'object') {
      if (typeof progress.percentage === 'number') {
        patch.progress_percentage = progress.percentage;
      }
      // Store detailed progress info
      patch.progress_details = {
        completed_nodes: progress.completed_nodes,
        total_nodes: progress.total_nodes,
        current_node: progress.current_node,
        current_node_progress: progress.current_node_progress
      };
    }
    
    // Extract video URL from files array if present
    if (files && Array.isArray(files)) {
      const videoFile = files.find(file => 
        file.type === 's3_url' && 
        file.filename && 
        (file.filename.endsWith('.mp4') || file.filename.endsWith('.webm'))
      );
      if (videoFile?.data) {
        // Convert to proxy URL if it matches our S3 endpoint
        patch.final_video_url = toProxiedUrl(videoFile.data);
      }
    }

    // Handle base64-encoded video payloads by uploading them to S3
    if (!patch.final_video_url && files && Array.isArray(files)) {
      const base64File = files.find(file =>
        file.type === 'base64' &&
        file.filename &&
        (file.filename.endsWith('.mp4') || file.filename.endsWith('.webm'))
      );

      if (base64File?.data) {
        try {
          const raw: string = typeof base64File.data === 'string' ? base64File.data.trim() : '';
          const base64Payload = raw.includes(',') ? raw.split(',').pop() : raw;
          const buffer = Buffer.from(base64Payload || '', 'base64');

          if (buffer.length === 0) {
            throw new Error('base64 payload empty');
          }

          const originalName: string = base64File.filename || '';
          const ext = originalName.includes('.') ? originalName.split('.').pop() || '' : '';

          const uploadedUrl = await uploadBufferToS3(buffer, ext);
          patch.final_video_url = uploadedUrl;
        } catch (err) {
          console.error(`[Webhook] Failed to upload base64 video for ${id}:`, err);
          patch.status = 'failed';
        }
      }
    }

    const finalStatus = patch.status;

    // Validate status is one of the allowed values
    const allowedStatuses = ['pending', 'processing', 'completed', 'failed', 'cancelled'];
    if (!allowedStatuses.includes(finalStatus)) {
      console.error(`[Webhook] Invalid status '${status}' for video ${id}. Allowed: ${allowedStatuses.join(', ')}`);
      return new Response(
        JSON.stringify({ error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // If we still do not have a final video URL and this is a completion event, mark as failed
    if (!patch.final_video_url && (finalStatus === 'completed' || finalStatus === 'failed')) {
      patch.status = 'failed';
    }

    // Clear progress when job completes or fails
    if (finalStatus === 'completed' || finalStatus === 'failed') {
      patch.progress_percentage = null;
      patch.progress_details = null;
    }

    // Calculate processing time if we have a start time and processing completed
    if (existing.processing_started_at && finalStatus === 'completed') {
      const startTime = new Date(existing.processing_started_at).getTime();
      const endTime = Date.now();
      patch.processing_time_ms = endTime - startTime;
    }

    // Validate field lengths before updating
    const validationErrors = validateVideoEntry({
      final_video_url: patch.final_video_url,
    });

    if (validationErrors.length > 0) {
      console.error(`[Webhook] Validation failed for video ${id}: ${formatValidationErrors(validationErrors)}`);
      return new Response(
        JSON.stringify({ error: formatValidationErrors(validationErrors) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const updated = await updateVideo(id, patch);

    return new Response(JSON.stringify({ success: true, updated }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};