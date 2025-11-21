import type { RequestHandler } from '@sveltejs/kit';
import { getAdminSettings, updateAdminSettings } from '$lib/db';

export const GET: RequestHandler = async ({ locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const settings = await getAdminSettings();
  
  return new Response(JSON.stringify(settings), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  
  const settings = await updateAdminSettings(body);
  
  return new Response(JSON.stringify(settings), {
    headers: { 'Content-Type': 'application/json' },
  });
};
