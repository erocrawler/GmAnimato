import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo, getAdminSettings, getWorkflowById, getDefaultWorkflow } from '$lib/db';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, retryRunPodJob, getRunPodJobStatus, mapRunPodStatus, submitRunPodJob } from '$lib/runpod';
import { buildWorkflow } from '$lib/i2vWorkflow';
import { buildFL2VWorkflow } from '$lib/fl2vWorkflow';
import { toOriginalUrl } from '$lib/serverImageUrl';

/**
 * Helper to submit a new RunPod job for a video
 * Uses stored workflow parameters from the original job submission
 */
async function submitNewRunPodJob(runpodConfig: any, video: any, origin: string) {
  const settings = await getAdminSettings();
  const callbackUrl = `${origin}/api/i2v-webhook/${video.id}`;

  // Use stored parameters from the video, or defaults if not available
  const iterationSteps = video.iteration_steps as (4 | 6 | 8) | undefined;
  const videoDuration = video.video_duration as (4 | 6) | undefined;
  const videoResolution = video.video_resolution as ('480p' | '720p') | undefined;

  // Detect workflow type from video
  const isFL2V = !!video.last_image_url;
  const workflowType = isFL2V ? 'fl2v' : 'i2v';

  // Resolve workflow to use
  let workflow = null;
  if (video.workflow_id) {
    workflow = await getWorkflowById(video.workflow_id);
  }
  if (!workflow) {
    workflow = await getDefaultWorkflow(workflowType);
  }
  if (!workflow) {
    throw new Error(`No ${workflowType.toUpperCase()} workflow configured`);
  }

  // Build the workflow from template with callback URL
  let payload;
  if (isFL2V) {
    // Convert proxy URLs to original S3 URLs for worker
    const originalImageUrl = toOriginalUrl(video.original_image_url);
    const lastImageUrl = toOriginalUrl(video.last_image_url!);
    
    payload = await buildFL2VWorkflow({
      first_image_name: `${video.id}_first.png`,
      first_image_url: originalImageUrl,
      last_image_name: `${video.id}_last.png`,
      last_image_url: lastImageUrl,
      input_prompt: video.prompt ?? 'A beautiful video',
      seed: video.seed ?? Math.floor(Math.random() * 1000000),
      callback_url: callbackUrl,
      iterationSteps,
      videoDuration,
      videoResolution,
      loraWeights: video.lora_weights,
      loraPresets: settings.loraPresets,
      workflow: workflow,
    });
  } else {
    // Convert proxy URL to original S3 URL for worker
    const originalImageUrl = toOriginalUrl(video.original_image_url);
    
    payload = await buildWorkflow({
      image_name: `${video.id}.png`,
      image_url: originalImageUrl,
      input_prompt: video.prompt ?? 'A beautiful video',
      seed: video.seed ?? Math.floor(Math.random() * 1000000),
      callback_url: callbackUrl,
      iterationSteps,
      videoDuration,
      videoResolution,
      loraWeights: video.lora_weights,
      loraPresets: settings.loraPresets,
      workflow: workflow,
    });
  }

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
        
        // Update video with new job ID, set as remote job, and status
        await updateVideo(id, { 
          status: 'in_queue',
          job_id: newJob.id,
          is_local_job: false
        });
        
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
          
          // Update video with new job ID, status, and ensure it's marked as remote
          await updateVideo(id, { 
            status: 'in_queue',
            job_id: newJob.id,
            is_local_job: false
          });
          
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
        await updateVideo(id, { status: internalStatus });
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
      
      // Update video status back to in_queue
      await updateVideo(id, { status: 'in_queue' });

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
