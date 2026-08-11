import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo, getAdminSettings } from '$lib/db';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, retryRunPodJob, getRunPodJobStatus, mapRunPodStatus, submitRunPodJob } from '$lib/runpod';
import { buildJobWorkflow, getCallbackUrl } from '$lib/jobWorkflow';

/**
 * Helper to submit a new RunPod job for a video
 * Uses stored workflow parameters from the original job submission.
 * Construction goes through the single shared path (MiniMax / FL2V / I2V) —
 * see src/lib/jobWorkflow.ts. (This is the "convert local job to RunPod" path
 * and previously duplicated construction logic without MiniMax support.)
 */
async function submitNewRunPodJob(runpodConfig: any, video: any, origin: string) {
  const settings = await getAdminSettings();
  // Always include the callback (CALLBACK_BASE_URL override supported).
  const callbackUrl = getCallbackUrl(origin, video.id);

  const { payload } = await buildJobWorkflow({
    video,
    settings,
    callbackUrl,
    useSageAttention: env.ENABLE_SAGE_ATTENTION_RUNPOD === 'true',
  });

  return await submitRunPodJob(runpodConfig, payload);
}

export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const video = await getVideoById(id);
    
    if (!video) {
      return new Response(JSON.stringify({ error: 'not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    if (video.status !== 'failed') {
      return new Response(JSON.stringify({ error: 'video is not in failed state' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    if (!video.job_id) {
      return new Response(JSON.stringify({ error: 'no job_id found for this video' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // Always use RunPod for retry, even if original was a local job
    // This provides better reliability for failed jobs
    const runpodConfig = getRunPodConfig({
      RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL,
      RUNPOD_API_KEY: env.RUNPOD_API_KEY
    });

    if (!runpodConfig) {
      return new Response(JSON.stringify({ error: 'RunPod not configured' }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const origin = new URL(request.url).origin;

    // If this was a local job, we need to submit it as a new RunPod job
    if (video.is_local_job) {
      console.log(`[Retry] Converting failed local job ${video.job_id} to RunPod job`);
      
      try {
        const newJob = await submitNewRunPodJob(runpodConfig, video, origin);
        
        // Update video with new job ID, set as remote job, and status.
        // Clear stale timing fields from the previous attempt — otherwise the
        // status-poll timeout would measure from the OLD dequeued_at and mark
        // the fresh job failed after ~30min even while it's still running.
        const updated = await updateVideo(id, { 
          status: 'in_queue',
          job_id: newJob.id,
          is_local_job: false,
          dequeued_at: undefined,
          processing_started_at: undefined
        });
        if (!updated) {
          throw new Error('Failed to update video status in database after job submission');
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Failed local job submitted to RunPod',
          job_id: newJob.id,
          status: 'in_queue',
          is_local: false
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      } catch (err) {
        console.error('[Retry] Error submitting local job to RunPod:', err);
        return new Response(JSON.stringify({ error: String(err) }), { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    try {
      // Check current job status first
      let jobStatus;
      try {
        jobStatus = await getRunPodJobStatus(runpodConfig, video.job_id);
      } catch (statusErr) {
        // If we get a 404, the job doesn't exist - submit as a new job
        if (String(statusErr).includes('404')) {
          console.log(`[Retry] Job ${video.job_id} not found (404), submitting as new job`);
          
          const newJob = await submitNewRunPodJob(runpodConfig, video, origin);
          
          // Update video with new job ID, status, and ensure it's marked as remote.
          // Clear stale timing fields (see above).
          const updated = await updateVideo(id, { 
            status: 'in_queue',
            job_id: newJob.id,
            is_local_job: false,
            dequeued_at: undefined,
            processing_started_at: undefined
          });
          if (!updated) {
            throw new Error('Failed to update video status in database after job submission');
          }
          
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Original job not found, submitted as new job',
            job_id: newJob.id,
            status: 'in_queue'
          }), { 
            headers: { 'Content-Type': 'application/json' } 
          });
        }
        throw statusErr;
      }

      // Map RunPod status to internal status
      const internalStatus = mapRunPodStatus(jobStatus.status);
      
      // If job is still processing or queued, update video status and don't retry
      if (internalStatus === 'in_queue' || internalStatus === 'processing') {
        const statusPatch: any = { status: internalStatus };
        if (internalStatus === 'processing') {
          statusPatch.dequeued_at = new Date().toISOString();
        }

        const updated = await updateVideo(id, statusPatch);
        if (!updated) {
          throw new Error('Failed to update video status in database after status check');
        }

        return new Response(JSON.stringify({ 
          success: true, 
          message: `Job is still ${internalStatus}, updated video status`, 
          job_id: video.job_id,
          status: internalStatus
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      // If job completed, update and return
      if (internalStatus === 'completed') {
        await updateVideo(id, { status: 'completed' });
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Job is already completed', 
          job_id: video.job_id,
          status: 'completed'
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      // Job is failed, proceed with retry
      await retryRunPodJob(runpodConfig, video.job_id);
      
      // Update video status back to in_queue. Clear stale timing fields from
      // the previous attempt so the status-poll timeout restarts fresh.
      const updated = await updateVideo(id, { 
        status: 'in_queue',
        dequeued_at: undefined,
        processing_started_at: undefined
      });
      if (!updated) {
        throw new Error('Failed to update video status in database after retry');
      }

      return new Response(JSON.stringify({ 
        success: true, 
        job_id: video.job_id,
        status: 'in_queue'
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    } catch (err) {
      console.error('[Retry] Error:', err);
      return new Response(JSON.stringify({ error: String(err) }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
  } catch (err) {
    console.error('[Retry] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
