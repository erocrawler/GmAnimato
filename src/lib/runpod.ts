export interface RunPodConfig {
  endpointUrl: string;
  apiKey: string;
}

export interface RunPodJobResponse {
  id: string;
  status: string;
  [key: string]: any;
}

export interface RunPodStatusResponse {
  id: string;
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | string;
  output?: {
    files?: Array<{
      filename: string;
      type: string;
      data: string;
    }>;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface RunPodHealthResponse {
  jobs: {
    inQueue: number;
    inProgress: number;
    completed: number;
    failed: number;
  };
  [key: string]: any;
}

export type InternalStatus = 'uploaded' | 'in_queue' | 'processing' | 'completed' | 'failed';

// Processing timeout: 30 minutes in milliseconds
export const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;

// Queue threshold: disable job submission if more than this many jobs in queue
export const MAX_QUEUE_THRESHOLD = 5000;

// Max concurrent jobs per user
export const MAX_USER_CONCURRENT_JOBS = 5;

/**
 * Get RunPod configuration from environment variables
 * Note: This function is meant to be called from server-side code only
 * Pass in the env object from '$env/dynamic/private'
 */
export function getRunPodConfig(envVars: {
  RUNPOD_ENDPOINT_URL?: string;
  RUNPOD_API_KEY?: string;
}): RunPodConfig | null {
  const endpointUrl = envVars.RUNPOD_ENDPOINT_URL;
  const apiKey = envVars.RUNPOD_API_KEY;

  if (!endpointUrl || !apiKey) {
    return null;
  }

  return { endpointUrl, apiKey };
}

/**
 * Submit a job to RunPod
 */
export async function submitRunPodJob(config: RunPodConfig, payload: any): Promise<RunPodJobResponse> {
  const url = `${config.endpointUrl}/run`;
  console.log(`[RunPod] Submitting job to ${url}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[RunPod] Job submission failed: ${response.status} - ${errorText}`);
    throw new Error(`RunPod API request failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(`[RunPod] Job submitted successfully:`, result);
  
  return result;
}

/**
 * Get the status of a RunPod job
 */
export async function getRunPodJobStatus(config: RunPodConfig, jobId: string): Promise<RunPodStatusResponse> {
  const url = `${config.endpointUrl}/status/${jobId}`;
  console.log(`[RunPod] Checking job status: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[RunPod] Status check failed: ${response.status} - ${errorText}`);
    throw new Error(`RunPod status request failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(`[RunPod] Job ${jobId} status:`, result);
  
  return result;
}

/**
 * Retry a failed RunPod job
 */
export async function retryRunPodJob(config: RunPodConfig, jobId: string): Promise<RunPodJobResponse> {
  const url = `${config.endpointUrl}/retry/${jobId}`;
  console.log(`[RunPod] Retrying job: ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[RunPod] Retry failed: ${response.status} - ${errorText}`);
    throw new Error(`RunPod retry request failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(`[RunPod] Job ${jobId} retry successful:`, result);
  
  return result;
}

/**
 * Get RunPod health/stats
 */
export async function getRunPodHealth(config: RunPodConfig): Promise<RunPodHealthResponse> {
  const url = `${config.endpointUrl}/health`;
  console.log(`[RunPod] Checking health: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[RunPod] Health check failed: ${response.status} - ${errorText}`);
    throw new Error(`RunPod health request failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(`[RunPod] Health status:`, result);
  
  return result;
}

/**
 * Map RunPod status to internal status
 */
export function mapRunPodStatus(runpodStatus: string): InternalStatus {
  const upperStatus = runpodStatus.toUpperCase();
  
  switch (upperStatus) {
    case 'IN_QUEUE':
      return 'in_queue';
    case 'IN_PROGRESS':
      return 'processing';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    default:
      console.warn(`[RunPod] Unknown status: ${runpodStatus}, defaulting to in_queue`);
      return 'in_queue';
  }
}

/**
 * Extract video URL from RunPod output files
 */
export function extractVideoUrl(statusData: RunPodStatusResponse): string | null {
  if (!statusData.output?.files || !Array.isArray(statusData.output.files)) {
    return null;
  }

  const videoFile = statusData.output.files.find(file => 
    file.type === 's3_url' && 
    file.filename && 
    (file.filename.endsWith('.mp4') || file.filename.endsWith('.webm'))
  );

  if (videoFile?.data) {
    console.log(`[RunPod] Found video URL: ${videoFile.data}`);
    return videoFile.data;
  }

  return null;
}
