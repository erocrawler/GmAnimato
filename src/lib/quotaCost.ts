/**
 * Configurable per-workflow quota cost rules.
 *
 * A workflow has a base `quotaCost` (credits per video). Optional `quotaCostRules`
 * adjust the cost when conditions match, e.g.:
 *   - cost 2x when a ref video is used (multiplier)
 *   - +1 credit when duration >= 8s (additive, positive)
 *   - -1 credit when a speed-up LoRA is enabled (additive, negative discount)
 *   - cost x0.5 when a speed-up LoRA is enabled (multiplier discount — use this
 *     INSTEAD of a "NOT using" condition: a 0.5 discount on the positive case
 *     is the same as a 2x surcharge on the negative case)
 *
 * Effective cost = round(base × product of all matching multipliers) + sum of
 * all matching additives, min 1.
 * This module is pure (no server-only imports) so it can run both in the kickoff
 * route and in the review page UI.
 */

export type QuotaCostRule = {
  id: string;
  label?: string;
  /** Multiplies the cost when the rule matches (e.g. 2 = "2x"). May be < 1 for
   *  discounts (e.g. 0.5 = "half price"). Omit when the rule only adds. */
  multiplier?: number;
  /** Adds a fixed number of credits when the rule matches. May be positive
   *  (surcharge, e.g. +1) or negative (discount, e.g. -1). Omit when the rule
   *  only multiplies. */
  additive?: number;
  when: {
    /** Applies when videoDuration >= minDuration (e.g. 8 covers 8s and 10s). */
    minDuration?: number;
    /** Applies when videoResolution equals this value. */
    exactResolution?: '480p' | '720p';
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
  const hasMultiplier =
    typeof v.multiplier === 'number' && Number.isFinite(v.multiplier) && v.multiplier > 0;
  const hasAdditive =
    typeof v.additive === 'number' && Number.isFinite(v.additive) && v.additive !== 0;
  // A rule must do something: multiply (incl. discounts) and/or add (incl. negative discounts).
  if (!hasMultiplier && !hasAdditive) return false;
  const when = (v.when ?? {}) as Record<string, unknown>;
  if (when.minDuration !== undefined && typeof when.minDuration !== 'number') return false;
  if (when.exactResolution !== undefined && when.exactResolution !== '480p' && when.exactResolution !== '720p') return false;
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
    additive: r.additive,
    when: {
      minDuration: r.when.minDuration,
      exactResolution: r.when.exactResolution,
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
  let added = 0;
  for (const rule of rules) {
    if (quotaCostRuleMatches(rule, params)) {
      if (typeof rule.multiplier === 'number') product *= rule.multiplier;
      if (typeof rule.additive === 'number') added += rule.additive;
    }
  }

  return Math.max(1, Math.round(base * product) + added);
}
