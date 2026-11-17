import type { RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getRunPodConfig, getRunPodHealth } from '$lib/runpod';
import { getAdminSettings } from '$lib/db';
import { jsonServerError } from '$lib/server/safe-error';

export const GET: RequestHandler = async () => {
  try {
    const settings = await getAdminSettings();
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
        threshold: settings.maxQueueThreshold,
        ...(queueFull && { 
          reason: `Queue is full (${inQueueCount}/${settings.maxQueueThreshold}). Please try again later.` 
        })
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    } catch (err) {
      console.error('[Health] Error checking RunPod health:', err);
      // If health check fails, assume service is unavailable
      return new Response(JSON.stringify({ 
        available: false,
        reason: 'Unable to check RunPod status',
        queueFull: false
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
  } catch (err) {
    return jsonServerError('[Health] Error:', err, {
      extra: { available: false, queueFull: false }
    });
  }
};
