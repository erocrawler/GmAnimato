import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, retryRunPodJob, getRunPodJobStatus, mapRunPodStatus, submitRunPodJob } from '$lib/runpod';

export const POST: RequestHandler = async ({ params }) => {
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

    try {
      // Check current job status first
      let jobStatus;
      try {
        jobStatus = await getRunPodJobStatus(runpodConfig, video.job_id);
      } catch (statusErr) {
        // If we get a 404, the job doesn't exist - submit as a new job
        if (String(statusErr).includes('404')) {
          console.log(`[Retry] Job ${video.job_id} not found (404), submitting as new job`);
          
          // Build payload from video data
          const payload = {
            input: {
              image_url: video.original_image_url,
              prompt: video.prompt || '',
              // Add other fields if needed
            }
          };
          
          const newJob = await submitRunPodJob(runpodConfig, payload);
          
          // Update video with new job ID and status
          await updateVideo(id, { 
            status: 'in_queue',
            job_id: newJob.id 
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
