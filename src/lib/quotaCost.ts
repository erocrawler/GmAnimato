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
    exactResolution?: '480p' | '720p' | '720p-hd' | '768p';
    /** Applies when ANY of these LoRA ids are enabled (present in loraWeights). */
    usingLoras?: string[];
    /** Applies when a reference video is / is not attached. Omit for either. */
    hasRefVideo?: boolean;
  };
};

export type QuotaCostParams = {
  videoDuration?: number;
  videoResolution?: string;
  loraWeights?: Record<string, number> | null;
  hasRefVideo?: boolean;
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
  if (when.exactResolution !== undefined && when.exactResolution !== '480p' && when.exactResolution !== '720p' && when.exactResolution !== '720p-hd' && when.exactResolution !== '768p') return false;
  if (when.usingLoras !== undefined && !Array.isArray(when.usingLoras)) return false;
  if (when.hasRefVideo !== undefined && typeof when.hasRefVideo !== 'boolean') return false;
  return true;
}

export type QuotaCostRuleRef = QuotaCostRule | string;

/** Prefix for named rule-set references inside quotaCostRules. Mirrored in quotaRuleSets.ts (kept duplicate to avoid a circularmport). */
export const QUOTA_RULE_SET_PREFIX = 'ruleset:';
export const QUOTA_RULE_SET_MAX_DEPTH = 10;

function isQuotaRuleSetRefLocal(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(QUOTA_RULE_SET_PREFIX) && v.length > QUOTA_RULE_SET_PREFIX.length;
}

/** Normalize a raw rules value (from DB JSON) into a safe array, preserving valid `ruleset:` refs. */
export function normalizeQuotaCostRules(raw: unknown): QuotaCostRuleRef[] {
  if (!Array.isArray(raw)) return [];
  const out: QuotaCostRuleRef[] = [];
  for (const r of raw) {
    if (typeof r === 'string') {
      if (isQuotaRuleSetRefLocal(r) && r.length <= 80) out.push(r);
      continue;
    }
    if (isQuotaCostRule(r)) {
      out.push({
        id: (r as QuotaCostRule).id || `rule-${Math.random().toString(36).slice(2, 8)}`,
        label: (r as QuotaCostRule).label,
        multiplier: (r as QuotaCostRule).multiplier,
        additive: (r as QuotaCostRule).additive,
        when: {
          minDuration: (r as QuotaCostRule).when.minDuration,
          exactResolution: (r as QuotaCostRule).when.exactResolution,
          usingLoras: Array.isArray((r as QuotaCostRule).when.usingLoras) ? (r as QuotaCostRule).when.usingLoras : undefined,
          hasRefVideo: typeof (r as QuotaCostRule).when.hasRefVideo === 'boolean' ? (r as QuotaCostRule).when.hasRefVideo : undefined,
        },
      });
    }
  }
  return out;
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
  if (w.hasRefVideo !== undefined) {
    // Conservative: a rule that cares about ref video never matches when the
    // caller didn't say whether one is attached. Otherwise a forgotten param
    // (retry, agent, batch job) would silently grant the "no video" discount.
    if (params.hasRefVideo === undefined) return false;
    if (params.hasRefVideo !== w.hasRefVideo) return false;
  }
  return true;
}

/**
 * Compute the effective credit cost for a video generated with the given workflow
 * and parameters. `ruleset:` refs in quotaCostRules are expanded via `library`
 * (admin_settings.quotaRuleSets); unknown sets expand to nothing, duplicate
 * rule ids apply once (first wins).
 *
 * @param workflow The workflow (needs quotaCost + quotaCostRules, refs allowed)
 * @param params Job parameters (duration, resolution, enabled LoRAs)
 * @param library Named rule sets, defaults to {}
 * @returns Effective credit cost, integer >= 1
 */
export function computeWorkflowQuotaCost(
  workflow: { quotaCost?: number; quotaCostRules?: (QuotaCostRule | string)[] | null },
  params: QuotaCostParams = {},
  library: Record<string, QuotaCostRule[]> | undefined | null = {},
): number {
  const base = typeof workflow.quotaCost === 'number' && workflow.quotaCost >= 1 ? workflow.quotaCost : 1;
  const raw = Array.isArray(workflow.quotaCostRules) ? workflow.quotaCostRules : [];
  const table = library && typeof library === 'object' ? library : {};

  const rules: QuotaCostRule[] = [];
  const seenIds = new Set<string>();
  const visit = (list: readonly (QuotaCostRule | string)[], path: string[], depth: number) => {
    if (depth > QUOTA_RULE_SET_MAX_DEPTH) return;
    for (const item of list) {
      if (typeof item === 'string') {
        if (!isQuotaRuleSetRefLocal(item)) continue;
        const name = item.slice(QUOTA_RULE_SET_PREFIX.length);
        if (path.includes(name)) continue;
        const inner = (table as Record<string, unknown>)[name];
        if (!Array.isArray(inner)) continue;
        visit(inner as (QuotaCostRule | string)[], [...path, name], depth + 1);
      } else if (isQuotaCostRule(item)) {
        const norm = normalizeQuotaCostRules([item])[0] as QuotaCostRule;
        if (seenIds.has(norm.id)) continue;
        seenIds.add(norm.id);
        rules.push(norm);
      }
    }
  };
  visit(raw, [], 0);

  let product = 1;
  let added = 0;
  for (const rule of rules) {
    if (quotaCostRuleMatches(rule, params)) {
      if (typeof rule.multiplier === 'number') product *= rule.multiplier;
      if (typeof rule.additive === 'number') added += rule.additive;
    }
  }

  // Additives belong to the base (e.g. a reference video adds its own cost BEFORE the resolution / length
  // multipliers apply): cost = (base + sum of additives) x product of multipliers, rounded once at the end.
  return Math.max(1, Math.round((base + added) * product));
}
