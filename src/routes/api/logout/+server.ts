import type { RequestHandler } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/db';

export const POST: RequestHandler = async ({ cookies }) => {
  // Get session token and delete from database
  const sessionToken = cookies.get('session');
  if (sessionToken) {
    await deleteSession(sessionToken);
  }
  
  cookies.delete('session', { path: '/' });
  throw redirect(303, '/login');
};
