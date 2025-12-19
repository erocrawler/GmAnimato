import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, getRunPodHealth } from '$lib/runpod';
import { getAdminSettings, getLocalJobStats } from '$lib/db';

export const GET: RequestHandler = async ({ locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const settings = await getAdminSettings();
    const localJobStats = await getLocalJobStats();
    const runpodConfig = getRunPodConfig({
      RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL,
      RUNPOD_API_KEY: env.RUNPOD_API_KEY
    });

    if (!runpodConfig) {
      return new Response(JSON.stringify({ 
        available: false,
        reason: 'RunPod not configured',
        queueFull: false
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    try {
      const health = await getRunPodHealth(runpodConfig);
      
      const inQueueCount = health.jobs?.inQueue || 0;
      const queueFull = inQueueCount >= settings.maxQueueThreshold;
      return new Response(JSON.stringify({ 
        available: !queueFull,
        queueFull,
        stats: {
          inQueue: inQueueCount,
          inProgress: health.jobs?.inProgress || 0,
          completed: health.jobs?.completed || 0,
          failed: health.jobs?.failed || 0
        },
        workers: health.workers || {
          idle: 0,
          initializing: 0,
          ready: 0,
          running: 0,
          throttled: 0,
          unhealthy: 0
        },
        threshold: settings.maxQueueThreshold,
        localQueue: {
          threshold: settings.localQueueThreshold,
          enabled: settings.localQueueThreshold > 0,
          inQueue: localJobStats.inQueue,
          processing: localJobStats.processing,
          completed: localJobStats.completed,
          failed: localJobStats.failed
        },
        ...(queueFull && { 
          reason: `Queue is full (${inQueueCount}/${settings.maxQueueThreshold}). Please try again later.` 
        })
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    } catch (err) {
      console.error('[Admin Queue Status] Error checking RunPod health:', err);
      return new Response(JSON.stringify({ 
        available: false,
        reason: 'Unable to check RunPod status',
        queueFull: false,
        error: String(err)
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
  } catch (err) {
    console.error('[Admin Queue Status] Error:', err);
    return new Response(JSON.stringify({ 
      error: String(err),
      available: false,
      queueFull: false
    }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
};
