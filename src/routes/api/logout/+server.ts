import type { RequestHandler } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';

export const POST: RequestHandler = async ({ cookies }) => {
  cookies.delete('session', { path: '/' });
  throw redirect(303, '/login');
};
