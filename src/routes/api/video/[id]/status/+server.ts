import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { env } from '$env/dynamic/private';

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
    // If video is in_queue or processing and we have a job_id, poll RunPod
    if ((video.status === 'in_queue' || video.status === 'processing') && video.job_id) {
      const VIDEO_STATUS_ENDPOINT_URL = env.VIDEO_STATUS_ENDPOINT_URL;
      const VIDEO_ENDPOINT_API_KEY = env.VIDEO_ENDPOINT_API_KEY;

      if (!VIDEO_STATUS_ENDPOINT_URL || !VIDEO_ENDPOINT_API_KEY) {
        // No polling configured, just return current status
        return new Response(JSON.stringify({ 
          status: video.status 
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      // Poll RunPod status endpoint
      const statusUrl = `${VIDEO_STATUS_ENDPOINT_URL}/${video.job_id}`;
      console.log(`[Status Poll] Checking job ${video.job_id} at ${statusUrl}`);

      const statusResponse = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${VIDEO_ENDPOINT_API_KEY}`
        }
      });

      if (!statusResponse.ok) {
        console.error(`[Status Poll] Failed to get status: ${statusResponse.status}`);
        return new Response(JSON.stringify({ 
          status: video.status 
        }), { 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      const statusData = await statusResponse.json();
      console.log(`[Status Poll] Job ${video.job_id} status:`, statusData);

      // Map api status to our internal status
      // e.g. RunPod uses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED
      let mappedStatus: 'in_queue' | 'processing' | 'completed' | 'failed' | 'uploaded' = video.status;
      let finalVideoUrl = video.final_video_url;
      
      if (statusData.status) {
        const apiStatus = statusData.status.toUpperCase();
        if (apiStatus === 'IN_QUEUE') {
          mappedStatus = 'in_queue';
        } else if (apiStatus === 'IN_PROGRESS') {
          mappedStatus = 'processing';
        } else if (apiStatus === 'COMPLETED') {
          mappedStatus = 'completed';
          
          // Extract video URL from output.files if available
          if (statusData.output?.files && Array.isArray(statusData.output.files)) {
            const videoFile = statusData.output.files.find((file: any) => 
              file.type === 's3_url' && file.filename && 
              (file.filename.endsWith('.mp4') || file.filename.endsWith('.webm'))
            );
            if (videoFile?.data) {
              finalVideoUrl = videoFile.data;
              console.log(`[Status Poll] Found video URL: ${finalVideoUrl}`);
            }
          }
        } else if (apiStatus === 'FAILED') {
          mappedStatus = 'failed';
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

      // Return the RunPod status along with our video status
      return new Response(JSON.stringify({ 
        status: mappedStatus,
        job_status: statusData.status,
        job_data: statusData
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
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
