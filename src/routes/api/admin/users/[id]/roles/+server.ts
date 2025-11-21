import type { RequestHandler } from '@sveltejs/kit';
import { updateUser } from '$lib/db';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userId = params.id;
  const body = await request.json();
  
  if (!body.roles || !Array.isArray(body.roles)) {
    return new Response(JSON.stringify({ error: 'Invalid roles' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const updated = await updateUser(userId, { roles: body.roles });
  
  if (!updated) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, user: updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
