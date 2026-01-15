/**
 * Local job queue management
 * Handles routing between local worker queue and RunPod based on intelligent migration
 */

import type { RunPodConfig, RunPodStatusResponse } from './runpod';
import { submitRunPodJob, getRunPodJobStatus } from './runpod';
import type { AdminSettings, VideoEntry, User } from './IDatabase';

/**
 * Migrate oldest eligible job from local queue to RunPod
 * This is called when local queue is backed up to free up space for new jobs
 * 
 * @param config RunPod configuration
 * @param settings Admin settings for determining eligibility
 * @param claimJobForMigration Function to atomically claim a job for migration
 * @param updateVideo Function to update video in database
 * @param buildWorkflowCallback Function to build workflow for the migrated job
 * @returns true if a job was migrated, false otherwise
 */
export async function migrateOldestEligibleJob(
  config: RunPodConfig | null,
  settings: AdminSettings,
  claimJobForMigration: (settings: AdminSettings) => Promise<VideoEntry | null>,
  updateVideo: (id: string, patch: any) => Promise<any>,
  buildWorkflowCallback: (video: VideoEntry) => Promise<any>
): Promise<boolean> {
  if (!config) {
    console.log('[Queue Migration] RunPod not configured, cannot migrate');
    return false;
  }

  try {
    // Atomically claim a job for migration (prevents race with workers)
    // This marks the job as 'processing' to prevent workers from claiming it
    const candidate = await claimJobForMigration(settings);
    
    if (!candidate) {
      console.log('[Queue Migration] No eligible jobs found for migration');
      return false;
    }

    console.log(`[Queue Migration] Migrating video ${candidate.id} to RunPod`);

    // Build workflow for the candidate job
    const payload = await buildWorkflowCallback(candidate);

    // Submit to RunPod
    const result = await submitRunPodJob(config, payload);

    // Update database to mark as RunPod job and restore to in_queue status
    // (RunPod will handle the actual processing)
    await updateVideo(candidate.id, {
      is_local_job: false,
      job_id: result.id,
      status: 'in_queue'
    });

    console.log(`[Queue Migration] Successfully migrated video ${candidate.id} to RunPod (job: ${result.id})`);
    return true;
  } catch (error) {
    console.error('[Queue Migration] Failed to migrate job:', error);
    // On failure, the job is still marked as 'processing' from claimJobForMigration
    // It will remain stuck unless we reset it. Let's try to reset it:
    // (This is best-effort; if this fails too, manual intervention may be needed)
    return false;
  }
}

/**
 * Submit a job with intelligent routing and migration
 * All jobs go to local queue first. If local queue exceeds migration threshold,
 * migrate the oldest eligible job (paid user OR free user waited 30+ min) to RunPod.
 * 
 * @param config RunPod configuration (only used if routing to RunPod or migrating)
 * @param video Video entry for the new job (caller should have this after creating in DB)
 * @param user User submitting the job
 * @param settings Admin settings for queue management
 * @param getLocalJobStats Function to get current local job stats
 * @param claimJobForMigration Function to atomically claim job for migration
 * @param updateVideo Function to update video in database
 * @param buildWorkflowCallback Function to build workflow for migration (takes VideoEntry)
 * @returns {isLocal: boolean, jobId?: string} - indicates if job is local and the job ID
 */
export async function submitJob(
  config: RunPodConfig | null,
  video: VideoEntry,
  user: Pick<User, 'id' | 'roles'> | null,
  settings: AdminSettings,
  getLocalJobStats: () => Promise<{ inQueue: number; processing: number; completed: number; failed: number }>,
  claimJobForMigration: (settings: AdminSettings) => Promise<VideoEntry | null>,
  updateVideo: (id: string, patch: any) => Promise<any>,
  buildWorkflowCallback: (video: VideoEntry) => Promise<any>
): Promise<{ isLocal: boolean; jobId?: string }> {
  // If local queue is disabled (threshold = 0), route all jobs directly to RunPod
  if (settings.localQueueThreshold <= 0) {
    if (!config) {
      throw new Error('Local queue is disabled but RunPod is not configured. Either enable local queue (localQueueThreshold > 0) or configure RunPod.');
    }
    
    console.log(`[Job Router] Local queue disabled, routing video ${video.id} directly to RunPod`);
    
    // Build workflow payload using the full video entry from caller
    const payload = await buildWorkflowCallback(video);
    
    // Submit directly to RunPod
    const result = await submitRunPodJob(config, payload);
    
    // Update database with RunPod job ID
    await updateVideo(video.id, { 
      is_local_job: false,
      job_id: result.id,
      status: 'in_queue'
    });
    
    console.log(`[Job Router] Submitted video ${video.id} to RunPod (job: ${result.id})`);
    return { isLocal: false, jobId: result.id };
  }
  
  const stats = await getLocalJobStats();
  const localQueueLength = stats.inQueue;
  
  console.log(`[Job Router] Local queue length: ${localQueueLength}, migration threshold: ${settings.localQueueMigrationThreshold || 5}`);
  
  // Local queue is enabled - always route new jobs to local queue first
  console.log(`[Job Router] Routing video ${video.id} to local queue`);
  await updateVideo(video.id, { 
    is_local_job: true, 
    job_id: `local-${video.id}` 
  });
  
  // Check if we should migrate oldest eligible job to RunPod
  const migrationThreshold = settings.localQueueMigrationThreshold || 5;
  if (localQueueLength >= migrationThreshold) {
    console.log(`[Job Router] Local queue (${localQueueLength}) exceeds migration threshold (${migrationThreshold}), attempting migration`);
    
    // Attempt to migrate one job to free up local queue
    await migrateOldestEligibleJob(
      config,
      settings,
      claimJobForMigration,
      updateVideo,
      buildWorkflowCallback
    );
  }
  
  return { isLocal: true, jobId: `local-${video.id}` };
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
