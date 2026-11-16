import type { AdminSettings, User } from '$lib/IDatabase';
import { checkDailyQuota, getActiveJobCountByUser, isUserPaid } from '$lib/db';
import { RESOLUTION_DISPLAY_NAME } from '$lib/workflowCapabilities';

/**
 * Shared "may this job be submitted?" gate for every route that puts a video
 * on a queue (kickoff, retry). Keeping one implementation means a stored
 * parameter set cannot be executed through a path that skips the daily
 * quota / tier checks that the path which stored it enforced.
 */

export type GateRejection = {
  status: number;
  body: Record<string, unknown>;
};

export function gateResponse(rejection: GateRejection): Response {
  return new Response(JSON.stringify(rejection.body), {
    status: rejection.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Advanced-features entitlement: any role with allowAdvancedFeatures. */
export function userHasAdvancedFeatures(roles: string[] | undefined, settings: AdminSettings): boolean {
  return (roles || []).some((roleName) =>
    settings.roles?.find((rc: any) => rc.name === roleName)?.allowAdvancedFeatures
  );
}

/** Max total prompt-relay frames per tier (free 121 / advanced 177). */
export function maxRelayFrames(hasAdvancedFeatures: boolean): number {
  return hasAdvancedFeatures ? 177 : 121;
}

export type SubmissionGateInput = {
  /** User whose daily credits are charged (needs id + roles). */
  quotaUser: Pick<User, 'id' | 'roles'>;
  settings: AdminSettings;
  /** Credits this job will consume. */
  quotaCost: number;
  resolution?: string | null;
  iterationSteps?: number | null;
  /** The workflow's free step ceiling (caps.freeSteps). */
  freeSteps: number;
  hasAdvancedFeatures: boolean;
  /** Sum of prompt-relay segment frames, when relay mode is on. */
  relayTotalFrames?: number;
};

/**
 * Daily quota, premium resolution, premium steps and relay-frame tier checks,
 * in the order kickoff has always applied them. Returns null when allowed.
 */
export async function checkSubmissionGate(input: SubmissionGateInput): Promise<GateRejection | null> {
  const { quotaUser, settings, quotaCost, resolution, iterationSteps, freeSteps, hasAdvancedFeatures, relayTotalFrames } = input;

  const quotaCheck = await checkDailyQuota(quotaUser, settings, quotaCost);
  if (quotaCheck.exceeded) {
    const errorCode = quotaCheck.limit === 0 ? 'quota_none' : 'quota_exceeded';
    return {
      status: 429,
      body: {
        error: `This video costs ${quotaCost} credit${quotaCost > 1 ? 's' : ''}. You have used ${quotaCheck.used} of your ${quotaCheck.limit} daily credits.`,
        errorCode,
        limit: quotaCheck.limit,
        used: quotaCheck.used,
        cost: quotaCost,
      },
    };
  }

  // Premium resolutions (everything above 480p) need advanced features.
  if (resolution && resolution !== '480p' && !hasAdvancedFeatures) {
    const name = (RESOLUTION_DISPLAY_NAME as Record<string, string>)[resolution] ?? resolution;
    return {
      status: 403,
      body: { error: `${name} resolution is available to users with advanced features only.` },
    };
  }

  // A step is premium when above THIS workflow's freeSteps (per-workflow, default 4).
  if (iterationSteps != null && iterationSteps > freeSteps && !hasAdvancedFeatures) {
    return {
      status: 403,
      body: { error: `${iterationSteps} iteration steps is available to users with advanced features only.` },
    };
  }

  if (relayTotalFrames !== undefined) {
    const maxFrames = maxRelayFrames(hasAdvancedFeatures);
    if (relayTotalFrames > maxFrames) {
      return {
        status: 403,
        body: { error: `Total relay frames (${relayTotalFrames}) exceeds the maximum of ${maxFrames} for your account tier.` },
      };
    }
  }

  return null;
}

/**
 * Per-user tier queue limit (free / paid). `ownerUserId` is whose active jobs
 * are counted; `tierUser` decides which limit applies.
 */
export async function checkQueueLimit(
  ownerUserId: string,
  tierUser: Pick<User, 'roles'>,
  settings: AdminSettings,
): Promise<GateRejection | null> {
  const activeJobCount = await getActiveJobCountByUser(ownerUserId);
  const queueLimit = isUserPaid(tierUser, settings) ? settings.paidUserQueueLimit : settings.freeUserQueueLimit;
  if (activeJobCount >= queueLimit) {
    return {
      status: 429,
      body: {
        error: `You have reached your queue limit of ${queueLimit} jobs. Please wait for some to complete.`,
        errorCode: 'queue_limit',
        limit: queueLimit,
      },
    };
  }
  return null;
}
