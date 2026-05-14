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
    const updated = await db.setDefaultWorkflow(id);

    if (!updated) {
      throw error(404, 'Workflow not found');
    }

    return json(updated);
  } catch (err: any) {
    if (err.status) throw err;
    console.error('Failed to set default workflow:', err);
    throw error(500, 'Failed to set default workflow');
  }
};
