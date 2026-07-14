import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';

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
  const { id, name, description, templatePath, workflowType, isDefault, compatibleLoraIds, tags, autoIncludeNewLoras, presetGroup } = body;

  if (!id || !name || !templatePath) {
    throw error(400, 'id, name, and templatePath are required');
  }

  if (workflowType && !['i2v', 'fl2v'].includes(workflowType)) {
    throw error(400, 'workflowType must be either "i2v" or "fl2v"');
  }

  if (!Array.isArray(compatibleLoraIds)) {
    throw error(400, 'compatibleLoraIds must be an array');
  }

  try {
    const created = await db.createWorkflow({
      id,
      name,
      description,
      templatePath,
      workflowType: workflowType || 'i2v',
      isDefault: isDefault || false,
      compatibleLoraIds,
      tags: Array.isArray(tags) ? tags.map((t: string) => String(t).toLowerCase()) : [],
      autoIncludeNewLoras: typeof autoIncludeNewLoras === 'boolean' ? autoIncludeNewLoras : true,
      presetGroup: typeof presetGroup === 'string' ? presetGroup : undefined,
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
