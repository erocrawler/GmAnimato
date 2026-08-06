/**
 * Configurable per-workflow quota cost rules.
 *
 * A workflow has a base `quotaCost` (credits per video). Optional `quotaCostRules`
 * apply multipliers when conditions match, e.g.:
 *   - cost 2x when the user did NOT enable a speed-up LoRA
 *   - cost 2x when duration >= 8s
 *
 * Effective cost = round(base × product of all matching rule multipliers), min 1.
 * This module is pure (no server-only imports) so it can run both in the kickoff
 * route and in the review page UI.
 */

export type QuotaCostRule = {
  id: string;
  label?: string;
  multiplier: number; // >= 1; e.g. 2 = "2x"
  when: {
    /** Applies when videoDuration >= minDuration (e.g. 8 covers 8s and 10s). */
    minDuration?: number;
    /** Applies when videoResolution equals this value. */
    exactResolution?: '480p' | '720p';
    /** Applies when NONE of these LoRA ids are enabled (present in loraWeights). */
    notUsingLoras?: string[];
    /** Applies when ANY of these LoRA ids are enabled (present in loraWeights). */
    usingLoras?: string[];
  };
};

export type QuotaCostParams = {
  videoDuration?: number;
  videoResolution?: string;
  loraWeights?: Record<string, number> | null;
};

export function isQuotaCostRule(value: unknown): value is QuotaCostRule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.multiplier !== 'number' || v.multiplier < 1) return false;
  const when = (v.when ?? {}) as Record<string, unknown>;
  if (when.minDuration !== undefined && typeof when.minDuration !== 'number') return false;
  if (when.exactResolution !== undefined && when.exactResolution !== '480p' && when.exactResolution !== '720p') return false;
  if (when.notUsingLoras !== undefined && !Array.isArray(when.notUsingLoras)) return false;
  if (when.usingLoras !== undefined && !Array.isArray(when.usingLoras)) return false;
  return true;
}

/** Normalize a raw rules value (from DB JSON) into a safe array. */
export function normalizeQuotaCostRules(raw: unknown): QuotaCostRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isQuotaCostRule).map((r) => ({
    id: r.id || `rule-${Math.random().toString(36).slice(2, 8)}`,
    label: r.label,
    multiplier: r.multiplier,
    when: {
      minDuration: r.when.minDuration,
      exactResolution: r.when.exactResolution,
      notUsingLoras: Array.isArray(r.when.notUsingLoras) ? r.when.notUsingLoras : undefined,
      usingLoras: Array.isArray(r.when.usingLoras) ? r.when.usingLoras : undefined,
    },
  }));
}

/** Whether a single rule matches the given job parameters. */
export function quotaCostRuleMatches(rule: QuotaCostRule, params: QuotaCostParams): boolean {
  const w = rule.when;
  if (w.minDuration !== undefined) {
    if (!(params.videoDuration !== undefined && params.videoDuration >= w.minDuration)) return false;
  }
  if (w.exactResolution !== undefined) {
    if (params.videoResolution !== w.exactResolution) return false;
  }
  if (w.notUsingLoras && w.notUsingLoras.length > 0) {
    // Applies only if NONE of the listed LoRAs are enabled
    const anyUsed = w.notUsingLoras.some((id) => !!params.loraWeights?.[id]);
    if (anyUsed) return false;
  }
  if (w.usingLoras && w.usingLoras.length > 0) {
    // Applies only if AT LEAST ONE of the listed LoRAs is enabled
    const anyUsed = w.usingLoras.some((id) => !!params.loraWeights?.[id]);
    if (!anyUsed) return false;
  }
  return true;
}

/**
 * Compute the effective credit cost for a video generated with the given workflow
 * and parameters.
 *
 * @param workflow The workflow (needs quotaCost + quotaCostRules)
 * @param params Job parameters (duration, resolution, enabled LoRAs)
 * @returns Effective credit cost, integer >= 1
 */
export function computeWorkflowQuotaCost(
  workflow: { quotaCost?: number; quotaCostRules?: QuotaCostRule[] | null },
  params: QuotaCostParams = {}
): number {
  const base = typeof workflow.quotaCost === 'number' && workflow.quotaCost >= 1 ? workflow.quotaCost : 1;
  const rules = Array.isArray(workflow.quotaCostRules) ? workflow.quotaCostRules : [];

  let product = 1;
  for (const rule of rules) {
    if (quotaCostRuleMatches(rule, params)) {
      product *= rule.multiplier;
    }
  }

  return Math.max(1, Math.round(base * product));
}
