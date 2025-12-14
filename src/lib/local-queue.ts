/**
 * Local job queue management
 * Handles routing between local worker queue and RunPod based on queue length
 */

import type { RunPodConfig, RunPodStatusResponse } from './runpod';
import { submitRunPodJob, getRunPodJobStatus } from './runpod';

/**
 * Submit a job - routes to local queue or RunPod based on local queue length
 * @param config RunPod configuration (only used if routing to RunPod)
 * @param payload Job payload
 * @param videoId Video ID for the job
 * @param localQueueThreshold Threshold from admin settings (0 = disabled, >0 = enabled)
 * @param getLocalQueueLength Function to get current local queue length
 * @param updateVideo Function to update video in database
 * @returns {isLocal: boolean, jobId?: string} - indicates if job is local and the job ID
 */
export async function submitJob(
  config: RunPodConfig | null,
  payload: any,
  videoId: string,
  localQueueThreshold: number,
  getLocalQueueLength: () => Promise<number>,
  updateVideo: (id: string, patch: any) => Promise<any>
): Promise<{ isLocal: boolean; jobId?: string }> {
  const localQueueLength = await getLocalQueueLength();
  
  console.log(`[Job Router] Local queue length: ${localQueueLength}, threshold: ${localQueueThreshold}`);
  
  // If threshold is 0 or less, local queue is disabled
  if (localQueueThreshold <= 0) {
    console.log(`[Job Router] Local queue disabled (threshold: ${localQueueThreshold})`);
    if (!config) {
      throw new Error('RunPod configuration is required when local queue is disabled');
    }
    console.log(`[Job Router] Routing video ${videoId} to RunPod`);
    const result = await submitRunPodJob(config, payload);
    await updateVideo(videoId, { 
      is_local_job: false, 
      job_id: result.id 
    });
    return { isLocal: false, jobId: result.id };
  }
  
  if (localQueueLength < localQueueThreshold) {
    // Route to local queue
    console.log(`[Job Router] Routing video ${videoId} to local queue`);
    await updateVideo(videoId, { 
      is_local_job: true, 
      job_id: `local-${videoId}` 
    });
    return { isLocal: true, jobId: `local-${videoId}` };
  } else {
    // Route to RunPod
    if (!config) {
      throw new Error('RunPod configuration is required when local queue is full');
    }
    console.log(`[Job Router] Routing video ${videoId} to RunPod`);
    const result = await submitRunPodJob(config, payload);
    await updateVideo(videoId, { 
      is_local_job: false, 
      job_id: result.id 
    });
    return { isLocal: false, jobId: result.id };
  }
}

/**
 * Get job status - handles both local and RunPod jobs
 * @param config RunPod configuration (only used for RunPod jobs)
 * @param video Video entry with job information
 * @returns Status response in RunPod format
 */
export async function getJobStatus(
  config: RunPodConfig | null,
  video: { job_id?: string; is_local_job?: boolean; status: string; final_video_url?: string }
): Promise<RunPodStatusResponse> {
  if (video.is_local_job) {
    // For local jobs, return status from database
    console.log(`[Job Status] Returning local job status for ${video.job_id}: ${video.status}`);
    
    // Map internal status to RunPod format
    let runpodStatus: string;
    switch (video.status) {
      case 'in_queue':
        runpodStatus = 'IN_QUEUE';
        break;
      case 'processing':
        runpodStatus = 'IN_PROGRESS';
        break;
      case 'completed':
        runpodStatus = 'COMPLETED';
        break;
      case 'failed':
        runpodStatus = 'FAILED';
        break;
      default:
        runpodStatus = 'IN_QUEUE';
    }
    
    return {
      id: video.job_id || 'local-unknown',
      status: runpodStatus,
      output: video.final_video_url ? {
        files: [{
          filename: 'output.mp4',
          type: 's3_url',
          data: video.final_video_url
        }]
      } : undefined
    };
  } else {
    // For RunPod jobs, query the API
    if (!config) {
      throw new Error('RunPod configuration is required for RunPod jobs');
    }
    if (!video.job_id) {
      throw new Error('Job ID is required for RunPod jobs');
    }
    return await getRunPodJobStatus(config, video.job_id);
  }
}
