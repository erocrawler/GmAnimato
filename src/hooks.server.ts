import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getSessionByToken, getUserById, deleteSession } from '$lib/db';
import { isSessionExpired } from '$lib/session';

/**
 * Secure session middleware
 * - Validates session token from cookie against database
 * - Checks session expiration and deletes expired sessions
 * - Attaches user data to event.locals.user
 * - Protects routes requiring authentication
 */
export const handle: Handle = async ({ event, resolve }) => {
  // Get session token from cookie
  const sessionToken = event.cookies.get('session');

  if (sessionToken) {
    try {
      // Validate session token from database
      const session = await getSessionByToken(sessionToken);
      
      if (session) {
        // Check if session is expired
        if (isSessionExpired(new Date(session.expires_at))) {
          // Delete expired session
          await deleteSession(sessionToken);
          event.cookies.delete('session', { path: '/' });
        } else {
          // Load user data from database
          const user = await getUserById(session.user_id);
          if (user) {
            event.locals.user = {
              id: user.id,
              username: user.username,
              email: user.email,
              roles: user.roles,
              created_at: user.created_at,
              updated_at: user.updated_at,
            };
          }
        }
      }
    } catch (err) {
      // Invalid session, ignore
      console.error('Session validation error:', err);
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

  // Check admin access for admin routes
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!event.locals.user?.roles?.includes('admin')) {
      throw redirect(303, '/');
    }
  }

  return await resolve(event);
};

