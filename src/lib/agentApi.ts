import type { VideoEntry, Workflow, AdminSettings } from './IDatabase';
import type { LoraPreset } from './loraPresets';
import { getWorkflowCapabilities, getWorkflowEngine, getWorkflowRunOn } from './workflows';
import { FREE_DURATION_MAX } from './workflowCapabilities';
import { workflowDefaultStep } from './workflowCapabilities';
import { maxAllowedDurationSeconds } from './mediaLimits';
import { toProxiedUrl } from './serverImageUrl';

/**
 * Serializers for the JSON endpoints meant for scripts and AI agents
 * (GET /api/workflows, /api/videos, /api/video/{id}, POST /api/uploads).
 * They expose the same facts the web UI uses, in stable snake_case JSON, and
 * never include internal fields (job ids, hashes, other users' data).
 */

export type VideoMode = 'i2v' | 'fl2v' | 'ref2v';

export function detectVideoMode(v: Pick<VideoEntry, 'last_image_url' | 'additional_options'>): VideoMode {
  if (v.additional_options?.ref2v === true) return 'ref2v';
  return v.last_image_url ? 'fl2v' : 'i2v';
}

const proxied = (u: string | undefined | null) => (u ? toProxiedUrl(u) : null);

export function serializeVideoSummary(v: VideoEntry) {
  return {
    id: v.id,
    status: v.status,
    mode: detectVideoMode(v),
    workflow_id: v.workflow_id ?? null,
    prompt: v.prompt ?? '',
    video_duration: v.video_duration ?? null,
    video_resolution: v.video_resolution ?? null,
    iteration_steps: v.iteration_steps ?? null,
    quota_cost: v.quota_cost ?? null,
    progress_percentage: v.progress_percentage ?? null,
    final_video_url: proxied(v.final_video_url),
    is_published: v.is_published ?? false,
    created_at: v.created_at,
    processing_started_at: v.processing_started_at ?? null,
    processing_time_ms: v.processing_time_ms ?? null,
  };
}

/** The additional_options keys that describe a video's inputs (no internal state). */
const DETAIL_OPTION_KEYS = [
  'ref2v',
  'ref_video_url',
  'ref_video_name',
  'ref_video_has_audio',
  'ref_video_duration',
  'ref_audio_url',
  'ref_audio_name',
  'ref_image_urls',
  'ref_image_names',
  'ref2v_aspect',
  'ref2v_follow_duration',
  'motion_scale',
  'freelong_blend_strength',
  'prompt_relay_mode',
  'prompt_relay_segments',
] as const;

export function serializeVideoDetail(v: VideoEntry) {
  const opts = (v.additional_options ?? {}) as Record<string, any>;
  const options: Record<string, unknown> = {};
  for (const k of DETAIL_OPTION_KEYS) {
    if (opts[k] === undefined) continue;
    if (k === 'ref_video_url' || k === 'ref_audio_url') options[k] = proxied(opts[k]) || opts[k];
    else if (k === 'ref_image_urls' && Array.isArray(opts[k])) options[k] = opts[k].map((u: string) => proxied(u) || u);
    else options[k] = opts[k];
  }
  return {
    ...serializeVideoSummary(v),
    original_image_url: proxied(v.original_image_url),
    last_image_url: proxied(v.last_image_url),
    lora_weights: v.lora_weights ?? null,
    seed: v.seed ?? null,
    is_nsfw: v.is_nsfw ?? null,
    options,
    failed: v.status === 'failed',
    review_url: `/new/review/${v.id}`,
  };
}

export function userHasAdvancedFeatures(roles: string[] | undefined, settings: Pick<AdminSettings, 'roles'>): boolean {
  return (roles ?? []).some((r) => settings.roles?.find((rc) => rc.name === r)?.allowAdvancedFeatures === true);
}

/**
 * One workflow as an agent needs to see it: what it accepts (resolved
 * allowlists, never "empty = default"), which values are premium, the LoRAs the
 * client must send with kickoff, and its credit cost.
 */
export function describeWorkflow(w: Workflow, loraPresets: LoraPreset[], hasAdvanced: boolean) {
  const caps = getWorkflowCapabilities(w);
  const engine = getWorkflowEngine(w);
  const tierMaxDuration = maxAllowedDurationSeconds(hasAdvanced);

  const premiumSteps = caps.steps.filter((s) => s > caps.freeSteps);
  const premiumDurations = caps.durations.filter((d) => d > FREE_DURATION_MAX);
  const premiumResolutions = caps.resolutions.filter((r) => r === '720p');

  const compatible = loraPresets.filter((l) => w.compatibleLoraIds.includes(l.id));
  const required = compatible.filter((l) => l.isConfigurable === false);
  const optional = compatible.filter((l) => l.isConfigurable !== false);

  return {
    id: w.id,
    name: w.name,
    description: w.description ?? null,
    type: w.workflowType,
    engine,
    run_on: getWorkflowRunOn(w),
    is_default: w.isDefault,
    quota_cost: w.quotaCost ?? 1,
    quota_cost_rules: w.quotaCostRules ?? [],
    steps: caps.steps,
    durations: caps.durations,
    resolutions: caps.resolutions,
    free_steps: caps.freeSteps,
    default_step: workflowDefaultStep(engine, w.capabilities),
    premium: {
      steps: premiumSteps,
      durations: premiumDurations,
      resolutions: premiumResolutions,
      requires_advanced_role: premiumSteps.length > 0 || premiumDurations.length > 0 || premiumResolutions.length > 0,
    },
    allowed_for_user: {
      steps: hasAdvanced ? caps.steps : caps.steps.filter((s) => s <= caps.freeSteps),
      durations: caps.durations.filter((d) => d <= tierMaxDuration),
      resolutions: hasAdvanced ? caps.resolutions : caps.resolutions.filter((r) => r !== '720p'),
    },
    // Required (non-optional) LoRAs: informational — kickoff always applies
    // them at their default weight (see withRequiredLoras in workflows.ts).
    required_loras: required.map((l) => ({ id: l.id, label: l.label, weight: l.default, chain: l.chain ?? null })),
    optional_loras: optional.map((l) => ({
      id: l.id,
      label: l.label,
      default: l.default,
      min: l.min ?? 0,
      max: l.max ?? 1.5,
      default_enabled: l.defaultEnabled ?? false,
      chain: l.chain ?? null,
      tags: l.tags ?? [],
    })),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(status: number, error: string, errorCode: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ error, errorCode, ...extra }, status);
}

/** Parse a positive integer query param with bounds; invalid -> default. */
export function intParam(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}
