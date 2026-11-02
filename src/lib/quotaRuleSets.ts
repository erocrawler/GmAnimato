/**
 * Named quota rule sets: reusable groups of QuotaCostRules.
 *
 * A workflow's `quotaCostRules` may contain concrete rule objects plus set
 * references of the form `ruleset:<name>`. Only the `ruleset:` prefix is
 * treated as a set; everything else must be a rule object. Sets live in
 * `admin_settings.quota_rule_sets` (see `normalizeQuotaRuleSets`) and are
 * expanded at compute time — the workflow row keeps the `ruleset:` refs,
 * never the expansion.
 */
import { isQuotaCostRule, normalizeQuotaCostRules, QUOTA_RULE_SET_PREFIX as COST_PREFIX, QUOTA_RULE_SET_MAX_DEPTH as COST_MAX_DEPTH, type QuotaCostRule } from './quotaCost';

export const QUOTA_RULE_SET_PREFIX = COST_PREFIX;
export const QUOTA_RULE_SET_MAX_DEPTH = COST_MAX_DEPTH;
export const QUOTA_RULE_SET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export type QuotaRuleSets = Record<string, (QuotaCostRule | string)[]>;
/** Workflow row may store inline rules plus `ruleset:` refs. */
export type QuotaCostRuleRef = QuotaCostRule | string;

export function isQuotaRuleSetRef(v: unknown): boolean {
  return typeof v === 'string' && (v as string).startsWith(QUOTA_RULE_SET_PREFIX) && (v as string).length > QUOTA_RULE_SET_PREFIX.length;
}

export function quotaRuleSetNameFromRef(ref: string): string {
  return ref.slice(QUOTA_RULE_SET_PREFIX.length);
}

export function isValidQuotaRuleSetName(name: unknown): boolean {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64 && QUOTA_RULE_SET_NAME_RE.test(name);
}

/** Normalize raw DB/JSON input into a clean name -> rules[] map. */
export function normalizeQuotaRuleSets(raw: unknown): QuotaRuleSets {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: QuotaRuleSets = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidQuotaRuleSetName(k)) continue;
    if (!Array.isArray(v)) continue;
    const rules = normalizeQuotaCostRules(v);
    out[k] = rules;
  }
  return out;
}

/**
 * Expand a mixed list of inline rules + `ruleset:` refs into flat rules.
 * - Order: first occurrence wins per rule id (duplicate ids would double-charge).
 * - Nested sets: a set's array is concrete rules only (no nested refs) by
 *   normalization, but we still guard: string entries inside a set that look
 *   like refs are resolved one level with cycle protection.
 * - Unknown sets expand to nothing.
 * - Returned list never contains strings.
 */
export function expandQuotaCostRules(
  rules: readonly QuotaCostRuleRef[] | undefined | null,
  sets: QuotaRuleSets | undefined | null,
): QuotaCostRule[] {
  const src = Array.isArray(rules) ? rules : [];
  const table = sets && typeof sets === 'object' ? sets : {};
  const out: QuotaCostRule[] = [];
  const seenIds = new Set<string>();
  const visitList = (list: readonly QuotaCostRuleRef[], path: string[], depth: number) => {
    if (depth > QUOTA_RULE_SET_MAX_DEPTH) return;
    for (const item of list) {
      if (typeof item === 'string') {
        if (!isQuotaRuleSetRef(item)) continue;
        const name = quotaRuleSetNameFromRef(item);
        if (path.includes(name)) continue;
        const inner = (table as Record<string, unknown>)[name];
        if (!Array.isArray(inner)) continue;
        visitList(inner as QuotaCostRuleRef[], [...path, name], depth + 1);
      } else if (isQuotaCostRule(item)) {
        const norm = normalizeQuotaCostRules([item])[0] as QuotaCostRule;
        if (!norm || typeof norm === 'string') continue;
        if (seenIds.has(norm.id)) continue;
        seenIds.add(norm.id);
        out.push(norm);
      }
    }
  };
  visitList(src, [], 0);
  return out;
}

/** Which defined sets reference a given set (directly), for rename/delete warnings. */
export function findDirectQuotaSetReferrers(sets: QuotaRuleSets, targetName: string): string[] {
  const want = `${QUOTA_RULE_SET_PREFIX}${targetName}`;
  const out: string[] = [];
  for (const [k, v] of Object.entries(sets)) {
    if (Array.isArray(v) && (v as unknown[]).includes(want as unknown as QuotaCostRule)) out.push(k);
  }
  return out;
}

/** Which workflows reference a given set (directly in quotaCostRules). */
export function findWorkflowQuotaSetUsages(
  workflows: ReadonlyArray<{ id: string; quotaCostRules?: readonly QuotaCostRuleRef[] | null }>,
  targetName: string,
): string[] {
  const want = `${QUOTA_RULE_SET_PREFIX}${targetName}`;
  return workflows
    .filter((w) => Array.isArray(w.quotaCostRules) && (w.quotaCostRules as readonly unknown[]).includes(want))
    .map((w) => w.id);
}
