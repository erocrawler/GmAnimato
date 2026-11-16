/**
 * Production wiring + scheduling for the hourly queue sweeper (see queueSweeper.ts).
 * Kept apart from queueSweeper.ts so the sweep logic stays free of infrastructure imports.
 */

import { env } from '$env/dynamic/private';
import {
  getAdminSettings,
  updateVideo,
  claimStaleLocalJob,
  failTimedOutProcessing,
} from '$lib/db';
import { getRunPodConfig, submitRunPodJob } from '$lib/runpod';
import { buildJobWorkflow, getCallbackUrl } from '$lib/jobWorkflow';
import { runQueueSweep, type QueueSweepDeps } from '$lib/queueSweeper';

const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

export function isQueueSweepDisabled(e: Record<string, string | undefined> = env): boolean {
  const v = (e.QUEUE_SWEEP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '::' ||
    h === '0.0.0.0' ||
    /^127\./.test(h)
  );
}

/**
 * The sweeper has no request, so it cannot use the request origin that kickoff/retry fall back
 * to. The only trustworthy sources are the operator-configured ones: CALLBACK_BASE_URL (the same
 * override getCallbackUrl honours) or, when that is unset, ORIGIN (adapter-node's public origin,
 * which is what request origins resolve to in production). A loopback/invalid value is useless to
 * RunPod, so it yields null instead of a guess.
 */
export function resolveCallbackBase(e: Record<string, string | undefined> = env): string | null {
  const raw = (e.CALLBACK_BASE_URL ?? '').trim() || (e.ORIGIN ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isLoopbackHost(u.hostname)) return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function createDefaultSweepDeps(): QueueSweepDeps {
  return {
    now: () => Date.now(),
    getAdminSettings: () => getAdminSettings(),
    failTimedOutProcessing: (cutoff) => failTimedOutProcessing(cutoff),
    claimStaleLocalJob: (olderThan, excludeIds) => claimStaleLocalJob(olderThan, excludeIds),
    updateVideo: (id, patch) => updateVideo(id, patch),
    getRunPodConfig: () =>
      getRunPodConfig({ RUNPOD_ENDPOINT_URL: env.RUNPOD_ENDPOINT_URL, RUNPOD_API_KEY: env.RUNPOD_API_KEY }),
    resolveCallbackBase: () => resolveCallbackBase(),
    buildPayload: async (video, settings, callbackBase) => {
      const { payload } = await buildJobWorkflow({
        video,
        settings,
        callbackUrl: getCallbackUrl(callbackBase, video.id),
        useSageAttention: env.ENABLE_SAGE_ATTENTION_RUNPOD === 'true',
      });
      return payload;
    },
    submitRunPodJob: (config, payload) => submitRunPodJob(config, payload),
  };
}

let started = false;

/**
 * Start the sweeper: first run ~2 minutes after startup, then hourly. Never throws, never
 * blocks startup (timers are unref'd), and a failing round is only logged. Multi-instance
 * safety is the database's job (atomic conditional writes), not this process's.
 */
export function startQueueSweeper(): void {
  if (started) return;
  if (isQueueSweepDisabled()) {
    console.log('[Queue Sweep] Disabled via QUEUE_SWEEP_DISABLED');
    return;
  }
  started = true;

  const tick = async () => {
    try {
      const summary = await runQueueSweep(createDefaultSweepDeps());
      if (summary.timedOut || summary.migrated || summary.migrationFailed || summary.errors.length) {
        console.log(
          `[Queue Sweep] done: timedOut=${summary.timedOut} migrated=${summary.migrated} ` +
            `migrationFailed=${summary.migrationFailed}${summary.skipped ? ` skipped=${summary.skipped}` : ''}`,
        );
      }
    } catch (err) {
      console.error('[Queue Sweep] Sweep error:', err);
    }
  };

  const first = setTimeout(() => {
    void tick();
    const interval = setInterval(() => void tick(), INTERVAL_MS);
    interval.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
  console.log('[Queue Sweep] Scheduled: first run in 2 minutes, then hourly');
}
