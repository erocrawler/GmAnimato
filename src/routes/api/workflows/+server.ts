import type { RequestHandler } from '@sveltejs/kit';
import { getAdminSettings, getWorkflows } from '$lib/db';
import { normalizeLoraPresets } from '$lib/loraPresets';
import { describeWorkflow, errorResponse, jsonResponse, userHasAdvancedFeatures } from '$lib/agentApi';
import { maxAllowedDurationSeconds } from '$lib/mediaLimits';

const TYPES = ['i2v', 'fl2v', 'ref2v'];

/**
 * GET /api/workflows[?type=i2v|fl2v|ref2v]
 * The models a user can pick for kickoff, with resolved steps/durations/
 * resolutions, premium flags, required LoRAs and credit cost.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) return errorResponse(401, 'Authentication required', 'unauthenticated');

  const type = url.searchParams.get('type');
  if (type && !TYPES.includes(type)) {
    return errorResponse(400, `type must be one of ${TYPES.join(', ')}`, 'invalid_type');
  }

  const [settings, workflows] = await Promise.all([getAdminSettings(), getWorkflows()]);
  const presets = normalizeLoraPresets(settings.loraPresets);
  const hasAdvanced = userHasAdvancedFeatures(locals.user.roles, settings);

  return jsonResponse({
    workflows: workflows
      .filter((w) => !w.isDeleted && (!type || w.workflowType === type))
      .map((w) => describeWorkflow(w, presets, hasAdvanced)),
    user: {
      has_advanced_features: hasAdvanced,
      max_duration_seconds: maxAllowedDurationSeconds(hasAdvanced),
    },
  });
};
