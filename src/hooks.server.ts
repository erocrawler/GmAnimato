import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';

/**
 * Simple session middleware for local dev.
 * - Reads a `session` cookie (JSON with `{id,username}`) and attaches it to `event.locals.user`.
 * - Protects routes under `/videos`, `/new`, and `/gallery` (except published items) by redirecting to `/login` when missing.
 * - Allows public access to `/login`, `/`, `/api/auth`.
 */
export const handle: Handle = async ({ event, resolve }) => {
  // Parse session cookie if present
  const sessionStr = event.cookies.get('session');

  if (sessionStr) {
    try {
      event.locals.user = JSON.parse(sessionStr);
    } catch (err) {
      // Invalid session cookie, ignore
    }
  }

  // Define public routes (no auth required)
  const publicRoutes = ['/login', '/', '/api/auth', '/gallery', '/api/logout', '/api/i2v-webhook'];
  const pathname = new URL(event.request.url).pathname;

  // Check if route is public
  const isPublic = publicRoutes.some((route) => pathname === route || pathname.startsWith(route + '/'));

  // Redirect to login if trying to access protected route without auth
  if (!isPublic && !event.locals.user) {
    throw redirect(303, '/login');
  }

  return await resolve(event);
};

