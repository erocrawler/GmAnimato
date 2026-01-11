import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, mapRunPodStatus, extractVideoUrl, PROCESSING_TIMEOUT_MS } from '$lib/runpod';
import { getJobStatus } from '$lib/local-queue';
import { toProxiedUrl } from '$lib/serverImageUrl';

export const GET: RequestHandler = async ({ params }) => {
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

    // If video is already completed or failed, return current status
    if (video.status === 'completed' || video.status === 'failed') {
      return new Response(JSON.stringify({ 
        status: video.status,
        final_video_url: video.final_video_url 
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    // If video is in_queue or processing but has no job_id, reset to uploaded
    if ((video.status === 'in_queue' || video.status === 'processing') && !video.job_id) {
      console.log(`[Status Poll] Video ${video.id} is ${video.status} but has no job_id, resetting to uploaded`);
      await updateVideo(video.id, { status: 'uploaded', processing_started_at: undefined });
      return new Response(JSON.stringify({ 
        status: 'uploaded'
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    // If video is in_queue or processing and we have a job_id, poll for status
    if ((video.status === 'in_queue' || video.status === 'processing') && video.job_id) {
      // Check if processing has timed out (longer than 30 minutes)
      if (video.processing_started_at) {
        const processingStartedAt = new Date(video.processing_started_at).getTime();
        const now = Date.now();
        const elapsedMs = now - processingStartedAt;
        
        if (elapsedMs > PROCESSING_TIMEOUT_MS) {
          console.log(`[Status Poll] Video ${video.id} has timed out after ${Math.floor(elapsedMs / 1000 / 60)} minutes`);
          await updateVideo(video.id, { status: 'failed' });
          return new Response(JSON.stringify({ 
            status: 'failed',
            reason: 'processing_timeout'
          }), { 
            headers: { 'Content-Type': 'application/json' } 
          });
        }
      }
      
      // For local jobs, just return the current DB status
      if (video.is_local_job) {
        console.log(`[Status Poll] Returning local job status for video ${video.id}: ${video.status}`);
        return new Response(JSON.stringify({ 
          status: video.status,
          is_local: true,
          final_video_url: video.final_video_url,
          progress_percentage: video.progress_percentage,
          progress_details: video.progress_details
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
      
      // For RunPod jobs, query the API
      const runpodConfig = getRunPodConfig({
        RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL,
        RUNPOD_API_KEY: env.RUNPOD_API_KEY
      });

      if (!runpodConfig) {
        // No polling configured, just return current status
        return new Response(JSON.stringify({ 
          status: video.status 
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      try {
        const statusData = await getJobStatus(runpodConfig, video);
        
        // Map RunPod status to internal status
        const mappedStatus = mapRunPodStatus(statusData.status);
        
        // Extract video URL if job completed
        let finalVideoUrl = video.final_video_url;
        if (mappedStatus === 'completed') {
          const extractedUrl = extractVideoUrl(statusData);
          if (extractedUrl) {
            // Convert to proxy URL if it matches our S3 endpoint
            finalVideoUrl = toProxiedUrl(extractedUrl);
          }
        }

        // Update database if status has changed or we have a new video URL
        if (mappedStatus !== video.status || (finalVideoUrl && finalVideoUrl !== video.final_video_url)) {
          console.log(`[Status Poll] Updating video ${video.id} - status: ${video.status} -> ${mappedStatus}, video_url: ${finalVideoUrl || 'none'}`);
          await updateVideo(video.id, { 
            status: mappedStatus,
            ...(finalVideoUrl && { final_video_url: finalVideoUrl })
          });
        }

        // Return the status along with our video status
        return new Response(JSON.stringify({ 
          status: mappedStatus,
          job_status: statusData.status,
          job_data: statusData,
          is_local: false
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      } catch (err) {
        console.error(`[Status Poll] Error checking job status:`, err);
        // Return current status if polling fails
        return new Response(JSON.stringify({ 
          status: video.status 
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }
    }

    // Default: return current video status
    return new Response(JSON.stringify({ 
      status: video.status 
    }), { 
      headers: { 'Content-Type': 'application/json' } 
    });
  } catch (err) {
    console.error('[Status Poll] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
