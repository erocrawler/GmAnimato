/**
 * Mock Local Worker for Development Testing
 * 
 * Simulates a local ComfyUI worker that:
 * 1. Polls for local jobs via /api/worker/task endpoint
 * 2. Claims jobs atomically (prevents race conditions)
 * 3. Simulates processing time (5-15 seconds)
 * 4. Completes jobs via webhook
 * 
 * Usage:
 *   node scripts/mock-local-worker.js
 * 
 * Environment Variables:
 *   API_BASE_URL - Base URL of the API (default: http://localhost:5173)
 *   WORKER_TASK_SECRET - Worker secret for authentication (required)
 *   WORKER_POLL_INTERVAL - Poll interval in ms (default: 2000)
 *   WORKER_PROCESSING_TIME - Processing time in ms (default: 8000)
 */

import { config } from 'dotenv';

config();

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5173';
const WORKER_TASK_SECRET = process.env.WORKER_TASK_SECRET;
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL || '2000');
const PROCESSING_TIME = parseInt(process.env.WORKER_PROCESSING_TIME || '8000');

let isProcessing = false;
let processedCount = 0;

/**
 * Claim a job from the worker endpoint
 * This calls GET /api/worker/task which atomically claims a job
 */
async function claimLocalJob() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/worker/task`, {
      method: 'GET',
      headers: {
        'x-worker-secret': WORKER_TASK_SECRET,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 404) {
      // No tasks available
      return null;
    }

    if (!response.ok) {
      const error = await response.json();
      console.error('[Worker] ❌ Error claiming job:', error);
      return null;
    }

    const job = await response.json();
    console.log(`[Worker] ✅ Claimed job ${job.id} for processing`);
    return job;
  } catch (error) {
    console.error('[Worker] ❌ Error claiming job:', error.message);
    return null;
  }
}

/**
 * Simulate processing a job and post result to webhook
 */
async function processJob(job) {
  const startTime = Date.now();
  console.log(`[Worker] 🔄 Processing job ${job.id}...`);
  
  try {
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, PROCESSING_TIME));
    
    const processingTimeMs = Date.now() - startTime;
    
    // Extract callback URL from job payload (built by buildWorkflow)
    const callbackUrl = job.input?.callback_url;
    
    if (!callbackUrl) {
      throw new Error('No callback_url found in job payload');
    }
    
    console.log(`[Worker] Posting completion to ${callbackUrl}`);
    
    // Extract video ID from job ID (format: local-{videoId})
    const videoId = job.id.replace(/^local-/, '');
    
    // Post completion to webhook
    const webhookPayload = {
      id: job.id, // Must match the job_id in database
      status: 'completed',
      files: [{
        filename: 'output.mp4',
        type: 's3_url',
        data: `https://mock-storage.example.com/videos/${videoId}.mp4`
      }]
    };
    
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(webhookPayload),
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }

    processedCount++;
    console.log(`[Worker] ✅ Completed job ${job.id} in ${processingTimeMs}ms (total processed: ${processedCount})`);
  } catch (error) {
    console.error(`[Worker] ❌ Error processing job ${job.id}:`, error.message);
    
    // Try to mark as failed via webhook
    try {
      const callbackUrl = job.input?.callback_url;
      if (!callbackUrl) {
        console.error(`[Worker] ❌ No callback URL to report failure`);
        return;
      }
      
      await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: job.id, // Must match the job_id in database
          status: 'failed',
          error: error.message
        }),
      });
    } catch (webhookError) {
      console.error(`[Worker] ❌ Failed to send error webhook:`, webhookError.message);
    }
  }
}

/**
 * Main worker loop
 */
async function workerLoop() {
  if (isProcessing) {
    return; // Skip if already processing a job
  }

  try {
    // Try to claim a job from the endpoint
    isProcessing = true;
    const job = await claimLocalJob();
    
    if (job) {
      await processJob(job);
    }
    
    isProcessing = false;
  } catch (error) {
    console.error('[Worker] ❌ Error in worker loop:', error.message);
    isProcessing = false;
  }
}

/**
 * Start the mock worker
 */
async function start() {
  console.log('🚀 Mock Local Worker Starting...');
  console.log(`📊 Configuration:`);
  console.log(`   - API Base URL: ${API_BASE_URL}`);
  console.log(`   - Poll Interval: ${POLL_INTERVAL}ms`);
  console.log(`   - Processing Time: ${PROCESSING_TIME}ms`);
  console.log(`   - Worker Secret: ${WORKER_TASK_SECRET ? '***' + WORKER_TASK_SECRET.slice(-4) : 'NOT SET'}`);
  console.log('');
  
  if (!WORKER_TASK_SECRET) {
    console.error('❌ WORKER_TASK_SECRET environment variable is required');
    process.exit(1);
  }
  
  // Test API connection
  try {
    const response = await fetch(`${API_BASE_URL}/api/worker/task`, {
      method: 'GET',
      headers: {
        'x-worker-secret': WORKER_TASK_SECRET,
      },
    });
    
    if (response.status === 401) {
      console.error('❌ Authentication failed: Invalid worker secret');
      process.exit(1);
    }
    
    console.log('✅ API connection successful\n');
  } catch (error) {
    console.error('❌ API connection failed:', error.message);
    console.error('   Make sure the dev server is running at', API_BASE_URL);
    process.exit(1);
  }

  // Start polling
  console.log('👀 Polling for local jobs...\n');
  setInterval(workerLoop, POLL_INTERVAL);
  
  // Run immediately
  workerLoop();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down mock worker...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\n🛑 Shutting down mock worker...');
  process.exit(0);
});

// Start the worker
start().catch(async (error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
