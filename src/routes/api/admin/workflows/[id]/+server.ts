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
  const { compatibleLoraIds, name, description, templatePath, isDefault } = body;

  if (compatibleLoraIds !== undefined && !Array.isArray(compatibleLoraIds)) {
    throw error(400, 'compatibleLoraIds must be an array');
  }

  try {
    // Build update data object
    const updateData: any = {
      updatedAt: new Date(),
    };
    
    if (compatibleLoraIds !== undefined) updateData.compatibleLoraIds = compatibleLoraIds;
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (templatePath !== undefined) updateData.templatePath = templatePath;
    if (isDefault !== undefined) {
      // If setting this as default, unset all others first
      if (isDefault) {
        await db.prisma.workflow.updateMany({
          data: { isDefault: false },
        });
      }
      updateData.isDefault = isDefault;
    }

    // Update workflow using direct Prisma access
    const updated = await db.prisma.workflow.update({
      where: { id },
      data: updateData,
    });

    return json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      templatePath: updated.templatePath,
      compatibleLoraIds: updated.compatibleLoraIds as string[],
      isDefault: updated.isDefault,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
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
    const workflow = await db.prisma.workflow.findUnique({
      where: { id },
    });

    if (!workflow) {
      throw error(404, 'Workflow not found');
    }

    if (workflow.isDefault) {
      throw error(400, 'Cannot delete the default workflow');
    }

    // Delete workflow
    await db.prisma.workflow.delete({
      where: { id },
    });

    return json({ success: true });
  } catch (err: any) {
    if (err.status) throw err;
    console.error('Failed to delete workflow:', err);
    throw error(500, 'Failed to delete workflow');
  }
};
