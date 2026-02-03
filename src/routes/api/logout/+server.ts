import type { RequestHandler } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/db';

export const POST: RequestHandler = async ({ cookies }) => {
  // Get refresh token and delete from database
  const refreshToken = cookies.get('refresh_token');
  if (refreshToken) {
    // Delete refresh token from database
    await deleteSession(refreshToken).catch(() => {});
  }
  
  // Delete both cookies
  cookies.delete('session', { path: '/' });
  cookies.delete('refresh_token', { path: '/' });
  throw redirect(303, '/login');
};
