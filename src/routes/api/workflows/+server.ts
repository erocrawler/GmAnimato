import type { RequestHandler } from '@sveltejs/kit';
import { getWorkflows } from '$lib/db';

/**
 * GET /api/workflows
 * Returns list of all available workflows
 */
export const GET: RequestHandler = async () => {
  try {
    const workflows = await getWorkflows();
    
    return new Response(
      JSON.stringify(workflows),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (err) {
    console.error('[Workflows API] Error fetching workflows:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch workflows' }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};
