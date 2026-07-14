import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  if (!locals.user.roles?.includes('admin')) throw error(403, 'Forbidden');

  const body = await request.json();
  const { workflowIds, loraIds, action } = body as {
    workflowIds: string[];
    loraIds: string[];
    action: 'add' | 'remove' | 'set';
  };

  if (!Array.isArray(workflowIds) || !Array.isArray(loraIds) || !['add', 'remove', 'set'].includes(action)) {
    throw error(400, 'workflowIds, loraIds arrays and action (add|remove|set) required');
  }

  try {
    const results = [];
    for (const wid of workflowIds) {
      const existing = await (db as any).prisma?.workflow?.findUnique?.({ where: { id: wid } }) ?? (await db.getWorkflows()).find(w => w.id === wid);
      // Fallback: use db method
      let currentIds: string[] = [];
      if (existing) {
        const arr = (existing as any).compatibleLoraIds ?? (existing as any).compatibleLoraIds;
        currentIds = Array.isArray(arr) ? arr : (typeof arr === 'string' ? JSON.parse(arr) : []);
      }
      let newIds: string[];
      if (action === 'add') {
        newIds = [...new Set([...currentIds, ...loraIds])];
      } else if (action === 'remove') {
        newIds = currentIds.filter(id => !loraIds.includes(id));
      } else {
        newIds = [...loraIds];
      }
      const updated = await db.updateWorkflow(wid, { compatibleLoraIds: newIds } as any);
      if (updated) results.push(updated);
    }
    return json({ success: true, workflows: results });
  } catch (err: any) {
    console.error('[bulk workflows]', err);
    throw error(500, err?.message || 'Failed to bulk update');
  }
};
