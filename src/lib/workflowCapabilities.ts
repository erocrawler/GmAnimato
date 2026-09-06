/**
 * Per-workflow engine + capability model.
 *
 * A workflow's runtime personality is defined on the DB row instead of being
 * inferred from its template path:
 *   - `engine`   — node-stack family: 'wan' | 'minimax'. Drives builder
 *                  dispatch and WAN-only feature gating (relay / motion scale /
 *                  free-long / LoRAs / negative prompt).
 *   - `runOn`    — runner routing: 'auto' (respect localQueueThreshold and
 *                  local→RunPod migration) | 'serverless' (ALWAYS RunPod, never
 *                  enqueued on a local worker).
 *   - `capabilities` — ALLOWLISTS only: which steps / durations / resolutions a
 *                  workflow may offer. Premium flags + defaults stay central
 *                  (see the metadata helpers below); empty = fall back to the
 *                  per-engine defaults so legacy rows need no value backfill.
 *
 * Pure module (no server-only imports) so it can run in kickoff, the review UI
 * and admin.
 */

export type WorkflowEngine = 'wan' | 'minimax';
export type WorkflowRunOn = 'auto' | 'serverless';

export type CapabilityStep = 4 | 6 | 8;
export type CapabilityDuration = 4 | 6 | 10 | 15;
export type CapabilityResolution = '480p' | '720p';

export interface WorkflowCapabilities {
  steps?: CapabilityStep[];
  durations?: CapabilityDuration[];
  resolutions?: CapabilityResolution[];
  /** Highest iteration step treated as FREE for THIS workflow (default 4).
   *  Steps above it are premium (require allowAdvancedFeatures). Raise it for
   *  workflows whose only viable mode is a higher step (e.g. an 8-NFE distilled
   *  turbo) so free users can run them — premium gating becomes per-workflow
   *  instead of a global ">4 is premium" rule. */
  freeSteps?: number;
}

export const KNOWN_STEPS: readonly CapabilityStep[] = [4, 6, 8];
export const KNOWN_DURATIONS: readonly CapabilityDuration[] = [4, 6, 10, 15];
export const KNOWN_RESOLUTIONS: readonly CapabilityResolution[] = ['480p', '720p'];

/** Central per-engine defaults (used when capabilities are empty/partial). */
export const ENGINE_DEFAULT_CAPABILITIES: Record<WorkflowEngine, Required<WorkflowCapabilities>> = {
  // WAN i2v/fl2v: 4 fast/free, 6 balanced/premium; 10s exists for relay mode.
  wan: { steps: [4, 6], durations: [4, 6, 10], resolutions: ['480p', '720p'], freeSteps: 4 },
  // MiniMax H3 distilled turbo NFE: 4 fast/free, 8 quality/premium. 10s/15s
  // are premium (15s MiniMax-only). Turbo-only workflows usually raise
  // freeSteps to 8 per-row so free users can run them.
  minimax: { steps: [4, 8], durations: [4, 6, 10, 15], resolutions: ['480p', '720p'], freeSteps: 4 },
};

/** Engine default step (the one auto-selected when a value isn't restored). */
export const ENGINE_DEFAULT_STEP: Record<WorkflowEngine, CapabilityStep> = {
  wan: 4,
  minimax: 8,
};

/** Cheap legacy fallback: infer the engine from the template filename. */
export function engineFromTemplatePath(templatePath?: string | null): WorkflowEngine {
  return (templatePath || '').toLowerCase().includes('minimax') ? 'minimax' : 'wan';
}

/** Normalize an arbitrary DB value into a safe capabilities object. */
export function normalizeWorkflowCapabilities(raw: unknown): WorkflowCapabilities {
  if (typeof raw !== 'object' || raw === null) return {};
  const v = raw as Record<string, unknown>;
  const out: WorkflowCapabilities = {};
  if (Array.isArray(v.steps)) {
    out.steps = v.steps
      .map((n) => Number(n))
      .filter((n): n is CapabilityStep => (KNOWN_STEPS as readonly number[]).includes(n));
  }
  if (Array.isArray(v.durations)) {
    out.durations = v.durations
      .map((n) => Number(n))
      .filter((n): n is CapabilityDuration => (KNOWN_DURATIONS as readonly number[]).includes(n));
  }
  if (Array.isArray(v.resolutions)) {
    out.resolutions = v.resolutions.filter(
      (r): r is CapabilityResolution => r === '480p' || r === '720p',
    );
  }
  if (v.freeSteps !== undefined) {
    const n = Number(v.freeSteps);
    const maxKnown = Math.max(...(KNOWN_STEPS as readonly number[]));
    if (Number.isInteger(n) && n >= 1 && n <= maxKnown) {
      out.freeSteps = n;
    }
  }
  return out;
}

/**
 * Effective, always-complete capability set for a workflow: its configured
 * allowlists merged over the engine defaults (an empty/partial list field
 * means "the engine default for that axis").
 */
export function resolveCapabilities(
  engine: WorkflowEngine,
  capabilities?: WorkflowCapabilities | null,
): Required<WorkflowCapabilities> {
  const defaults = ENGINE_DEFAULT_CAPABILITIES[engine] ?? ENGINE_DEFAULT_CAPABILITIES.wan;
  const caps = capabilities ?? {};
  return {
    steps: caps.steps && caps.steps.length > 0 ? caps.steps : defaults.steps,
    durations:
      caps.durations && caps.durations.length > 0 ? caps.durations : defaults.durations,
    resolutions:
      caps.resolutions && caps.resolutions.length > 0
        ? caps.resolutions
        : defaults.resolutions,
    freeSteps:
      typeof caps.freeSteps === 'number' && caps.freeSteps >= 1
        ? caps.freeSteps
        : defaults.freeSteps,
  };
}

// ---- Central premium/default metadata (value → flags/labels) ----------------
// DEFAULT tier rules, deliberately NOT stored per workflow — except `freeSteps`,
// which a workflow may override per-row (see WorkflowCapabilities.freeSteps).

/** A step at or below this value is free by default; anything above is premium.
 *  A workflow's capabilities.freeSteps may raise this (e.g. 8 for turbo-only). */
export const FREE_STEP_MAX = 4 as const;
/** A duration at or below this value is free; anything above is premium. */
export const FREE_DURATION_MAX = 6 as const;

/** i18n label key suffix for a step value under `review.iteration.*`. */
export const STEP_LABEL_KEY: Record<number, string> = {
  4: 'fast',
  6: 'balanced',
  8: 'quality',
};

/** MiniMax-specific step description keys (fall back to steps.* otherwise). */
export const MINIMAX_STEP_DESC_KEY: Record<number, string> = {
  4: 'minimaxStepsFast',
  8: 'minimaxStepsQuality',
};

/** i18n label key for a duration value under `review.duration.*`. */
export const DURATION_LABEL_KEY: Record<number, string> = {
  4: 'short',
  6: 'long',
  10: 'extended',
  15: 'ultra',
};
