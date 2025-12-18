import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';

export const POST: RequestHandler = async ({ locals, params }) => {
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
    // Unset all workflows as default
    await db.prisma.workflow.updateMany({
      data: { isDefault: false },
    });

    // Set this workflow as default
    const updated = await db.prisma.workflow.update({
      where: { id },
      data: {
        isDefault: true,
        updatedAt: new Date(),
      },
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
    console.error('Failed to set default workflow:', err);
    throw error(500, 'Failed to set default workflow');
  }
};
