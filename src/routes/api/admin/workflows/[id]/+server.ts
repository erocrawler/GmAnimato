import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  // Check authentication
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  // Check admin role
  if (!locals.user.roles?.includes('admin')) {
    throw error(403, 'Forbidden: Admin access required');
  }

  const { id } = params;
  const body = await request.json();
  const { compatibleLoraIds, name, description, templatePath, workflowType, isDefault } = body;

  if (compatibleLoraIds !== undefined && !Array.isArray(compatibleLoraIds)) {
    throw error(400, 'compatibleLoraIds must be an array');
  }

  if (workflowType !== undefined && !['i2v', 'fl2v'].includes(workflowType)) {
    throw error(400, 'workflowType must be either "i2v" or "fl2v"');
  }

  try {
    // Build patch object
    const patch: Parameters<typeof db.updateWorkflow>[1] = {};
    if (compatibleLoraIds !== undefined) patch.compatibleLoraIds = compatibleLoraIds;
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (templatePath !== undefined) patch.templatePath = templatePath;
    if (workflowType !== undefined) patch.workflowType = workflowType;
    if (isDefault !== undefined) patch.isDefault = isDefault;

    const updated = await db.updateWorkflow(id, patch);

    if (!updated) {
      throw error(404, 'Workflow not found');
    }

    return json(updated);
  } catch (err: any) {
    if (err.status) throw err;
    console.error('Failed to update workflow:', err);
    throw error(500, 'Failed to update workflow');
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  // Check authentication
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  // Check admin role
  if (!locals.user.roles?.includes('admin')) {
    throw error(403, 'Forbidden: Admin access required');
  }

  const { id } = params;

  try {
    // Check if this is the default workflow
    const workflow = await db.getWorkflowById(id);

    if (!workflow) {
      throw error(404, 'Workflow not found');
    }

    if (workflow.isDefault) {
      throw error(400, 'Cannot delete the default workflow');
    }

    // Delete workflow
    await db.deleteWorkflow(id);

    return json({ success: true });
  } catch (err: any) {
    if (err.status) throw err;
    console.error('Failed to delete workflow:', err);
    throw error(500, 'Failed to delete workflow');
  }
};
