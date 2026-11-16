/**
 * Hourly queue sweeper.
 *
 * Two jobs that previously only happened as a side effect of user traffic:
 *
 *  1. Time out stuck jobs. A job still 'processing' whose dequeued_at is older than
 *     PROCESSING_TIMEOUT_MS is marked 'failed'. (The status endpoint does the same check,
 *     but only when somebody polls that exact video.)
 *  2. Move over-long local waits to RunPod. A local 'in_queue' job that has been waiting longer
 *     than freeUserWaitThresholdMinutes is submitted to RunPod, for every role alike.
 *     (submitJob only migrates one job, and only when a new job arrives.)
 *
 * This module is pure with respect to infrastructure: every dependency (DB calls, RunPod
 * submission, clock, logger) is injected, so it is unit-testable and the real wiring lives in
 * queueSweeperRuntime.ts. Multi-instance safety comes from the database: both DB methods are
 * single atomic conditional writes (see IDatabase.failTimedOutProcessing / claimStaleLocalJob);
 * the in-process flag below only stops one instance from overlapping with itself.
 */

import type { AdminSettings, VideoEntry } from './IDatabase';
import { PROCESSING_TIMEOUT_MS, type RunPodConfig } from './runpod';
import { migrateOldestEligibleJob } from './local-queue';

/** Upper bound of migrations per sweep, so one sweep cannot flood RunPod. */
export const MAX_MIGRATIONS_PER_SWEEP = 20;
/** Stop the migration batch after this many consecutive claim errors (DB trouble). */
const MAX_CONSECUTIVE_CLAIM_ERRORS = 3;
const DEFAULT_WAIT_THRESHOLD_MINUTES = 30;

export interface QueueSweepLogger {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface QueueSweepDeps {
  /** Clock, epoch milliseconds. */
  now: () => number;
  getAdminSettings: () => Promise<AdminSettings>;
  failTimedOutProcessing: (cutoff: Date) => Promise<string[]>;
  claimStaleLocalJob: (olderThan: Date, excludeIds?: string[]) => Promise<VideoEntry | null>;
  updateVideo: (id: string, patch: any) => Promise<any>;
  /** null when RunPod is not configured. */
  getRunPodConfig: () => RunPodConfig | null;
  /**
   * Externally reachable base URL for webhook callbacks, or null when none can be determined
   * (the sweeper has no request origin to fall back on).
   */
  resolveCallbackBase: () => string | null;
  /** Build the RunPod payload for a job (same construction path as kickoff/retry). */
  buildPayload: (video: VideoEntry, settings: AdminSettings, callbackBase: string) => Promise<any>;
  submitRunPodJob: (config: RunPodConfig, payload: any) => Promise<{ id: string }>;
  logger?: QueueSweepLogger;
  /** Overrides, mainly for tests. */
  processingTimeoutMs?: number;
  maxMigrations?: number;
}

export interface QueueSweepSummary {
  /** Jobs moved to RunPod. */
  migrated: number;
  /** Jobs marked failed because processing exceeded the timeout. */
  timedOut: number;
  /** Claimed jobs whose migration failed and were reset to in_queue. */
  migrationFailed: number;
  /** Why the migration part (or the whole sweep) did not run; omitted when it ran. */
  skipped?: string;
  /** Ids touched, for logging / assertions. */
  timedOutIds: string[];
  migratedIds: string[];
  /** Non-fatal errors caught while sweeping. */
  errors: string[];
}

let sweepInFlight = false;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runQueueSweep(deps: QueueSweepDeps): Promise<QueueSweepSummary> {
  const logger = deps.logger ?? console;
  const summary: QueueSweepSummary = {
    migrated: 0,
    timedOut: 0,
    migrationFailed: 0,
    timedOutIds: [],
    migratedIds: [],
    errors: [],
  };

  if (sweepInFlight) {
    logger.log('[Queue Sweep] previous sweep still running, skipping');
    return { ...summary, skipped: 'already-running' };
  }
  sweepInFlight = true;
  try {
    // ---- 1. processing timeouts (DB only; independent of RunPod / settings) ----
    try {
      const cutoff = new Date(deps.now() - (deps.processingTimeoutMs ?? PROCESSING_TIMEOUT_MS));
      if (Number.isNaN(cutoff.getTime())) throw new Error('invalid timeout cutoff (bad clock or PROCESSING_TIMEOUT_MS)');
      const ids = await deps.failTimedOutProcessing(cutoff);
      summary.timedOut = ids.length;
      summary.timedOutIds = ids;
      if (ids.length > 0) {
        logger.log(`[Queue Sweep] Marked ${ids.length} timed-out processing job(s) as failed: ${ids.join(', ')}`);
      }
    } catch (err) {
      summary.errors.push(`timeout: ${describe(err)}`);
      logger.error('[Queue Sweep] Timeout sweep failed:', err);
    }

    // ---- 2. long local waits -> RunPod ----
    const config = deps.getRunPodConfig();
    if (!config) {
      summary.skipped = 'runpod-not-configured';
      logger.log('[Queue Sweep] RunPod not configured, skipping migration of stale local jobs');
      return summary;
    }
    const callbackBase = deps.resolveCallbackBase();
    if (!callbackBase) {
      summary.skipped = 'no-callback-base';
      logger.warn(
        '[Queue Sweep] No reliable external callback base URL (set CALLBACK_BASE_URL, or ORIGIN to a non-loopback address); ' +
          'skipping migration of stale local jobs',
      );
      return summary;
    }

    try {
      const settings = await deps.getAdminSettings();
      const waitMinutes = settings.freeUserWaitThresholdMinutes || DEFAULT_WAIT_THRESHOLD_MINUTES;
      const olderThan = new Date(deps.now() - waitMinutes * 60 * 1000);
      const max = deps.maxMigrations ?? MAX_MIGRATIONS_PER_SWEEP;

      // The reservation (claimStaleLocalJob) stamps dequeued_at as a leash; clear it on both
      // outcomes so an in_queue row (migrated or reset) never carries a stale dequeued_at.
      const updateVideo = (id: string, patch: any) => deps.updateVideo(id, { ...patch, dequeued_at: null });

      const failedIds: string[] = [];
      let claimErrors = 0;
      for (let i = 0; i < max; i++) {
        const state: { claimed: VideoEntry | null; threw: boolean } = { claimed: null, threw: false };
        const claim = async () => {
          try {
            state.claimed = await deps.claimStaleLocalJob(olderThan, failedIds);
          } catch (err) {
            state.threw = true;
            summary.errors.push(`claim: ${describe(err)}`);
            throw err;
          }
          return state.claimed;
        };

        const ok = await migrateOldestEligibleJob(
          config,
          settings,
          claim,
          updateVideo,
          (video) => deps.buildPayload(video, settings, callbackBase),
          deps.submitRunPodJob,
        );

        if (ok) {
          claimErrors = 0;
          summary.migrated++;
          if (state.claimed) summary.migratedIds.push(state.claimed.id);
          continue;
        }
        if (state.threw) {
          // migrateOldestEligibleJob already logged it; give up if the DB keeps failing.
          if (++claimErrors >= MAX_CONSECUTIVE_CLAIM_ERRORS) {
            logger.error('[Queue Sweep] Repeated claim errors, aborting migration batch');
            break;
          }
          continue;
        }
        claimErrors = 0;
        if (!state.claimed) break; // nothing (more) to migrate
        // Claimed but build/submit failed: migrateOldestEligibleJob reset it to in_queue.
        // Exclude it for the rest of this sweep so the loop moves on to the next-oldest job.
        summary.migrationFailed++;
        failedIds.push(state.claimed.id);
      }

      if (summary.migrated > 0 || summary.migrationFailed > 0) {
        logger.log(
          `[Queue Sweep] Migrated ${summary.migrated} stale local job(s) to RunPod, ${summary.migrationFailed} failed (reset to in_queue)`,
        );
      }
    } catch (err) {
      summary.errors.push(`migrate: ${describe(err)}`);
      logger.error('[Queue Sweep] Migration sweep failed:', err);
    }
    return summary;
  } finally {
    sweepInFlight = false;
  }
}
