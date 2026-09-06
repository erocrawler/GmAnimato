import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { normalizeQuotaCostRules } from '$lib/quotaCost';
import { normalizeWorkflowCapabilities, engineFromTemplatePath } from '$lib/workflowCapabilities';

function parseEngine(raw: unknown, templatePath?: string): string {
  if (raw === 'wan' || raw === 'minimax') return raw;
  return engineFromTemplatePath(templatePath);
}

export const POST: RequestHandler = async ({ locals, request }) => {
  // Check authentication
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  // Check admin role
  if (!locals.user.roles?.includes('admin')) {
    throw error(403, 'Forbidden: Admin access required');
  }

  const body = await request.json();
  const { id, name, description, templatePath, workflowType, isDefault, compatibleLoraIds, tags, autoIncludeNewLoras, presetGroup, quotaCost, quotaCostRules, engine, runOn, capabilities } = body;

  if (!id || !name || !templatePath) {
    throw error(400, 'id, name, and templatePath are required');
  }

  if (workflowType && !['i2v', 'fl2v', 'ref2v'].includes(workflowType)) {
    throw error(400, 'workflowType must be "i2v", "fl2v", or "ref2v"');
  }

  if (engine !== undefined && engine !== 'wan' && engine !== 'minimax') {
    throw error(400, 'engine must be "wan" or "minimax"');
  }
  if (runOn !== undefined && runOn !== 'auto' && runOn !== 'serverless') {
    throw error(400, 'runOn must be "auto" or "serverless"');
  }
  if (capabilities !== undefined && typeof capabilities !== 'object') {
    throw error(400, 'capabilities must be an object');
  }

  if (!Array.isArray(compatibleLoraIds)) {
    throw error(400, 'compatibleLoraIds must be an array');
  }

  if (quotaCost !== undefined && (!Number.isInteger(quotaCost) || quotaCost < 1)) {
    throw error(400, 'quotaCost must be an integer >= 1');
  }

  try {
    const created = await db.createWorkflow({
      id,
      name,
      description,
      templatePath,
      workflowType: workflowType || 'i2v',
      engine: parseEngine(engine, templatePath),
      runOn: runOn || 'auto',
      capabilities: normalizeWorkflowCapabilities(capabilities),
      isDefault: isDefault || false,
      compatibleLoraIds,
      tags: Array.isArray(tags) ? tags.map((t: string) => String(t).toLowerCase()) : [],
      autoIncludeNewLoras: typeof autoIncludeNewLoras === 'boolean' ? autoIncludeNewLoras : true,
      presetGroup: typeof presetGroup === 'string' ? presetGroup : undefined,
      quotaCost: typeof quotaCost === 'number' ? quotaCost : 1,
      quotaCostRules: normalizeQuotaCostRules(quotaCostRules),
    } as any);

    return json(created);
  } catch (err: any) {
    console.error('Failed to create workflow:', err);
    if (err.code === 'P2002') {
      throw error(400, 'A workflow with this ID already exists');
    }
    throw error(500, 'Failed to create workflow');
  }
};
