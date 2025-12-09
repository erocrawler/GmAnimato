import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getSessionByToken, getUserById, deleteSession, deleteExpiredSessions } from '$lib/db';
import { isSessionExpired } from '$lib/session';
import { building } from '$app/environment';

/**
 * Schedule cleanup task to run at a specific time each day (3 AM server local time)
 */
function scheduleCleanupTask() {
  const now = new Date();
  const nextRun = new Date();
  
  // Set to 3 AM local time
  nextRun.setHours(3, 0, 0, 0);
  
  // If it's already past 3 AM today, schedule for tomorrow
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }
  
  const delay = nextRun.getTime() - now.getTime();
  
  console.log(`[Background Tasks] Cleanup scheduled for ${nextRun.toString()}`);
  
  // Schedule for the first time
  setTimeout(async () => {
    await runCleanup();
    // Then repeat every 24 hours
    setInterval(runCleanup, 1000 * 60 * 60 * 24);
  }, delay);
}

async function runCleanup() {
  try {
    console.log('[Background Tasks] Running session cleanup...');
    const deleted = await deleteExpiredSessions();
    console.log(`[Background Tasks] Deleted ${deleted} expired sessions`);
  } catch (err) {
    console.error('[Background Tasks] Cleanup error:', err);
  }
}

// Initialize background tasks on server start (not during build)
if (!building) {
  console.log('[Background Tasks] Server started: Initializing...');
  scheduleCleanupTask();
}

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
  const publicRoutes = [
    '/',
    '/login',
    '/api/auth',
    '/gallery',
    '/api/logout',
    '/api/i2v-webhook',
    '/auth/gmgard',
    '/auth/gmgard/callback'
  ];
  const pathname = new URL(event.request.url).pathname;

  // Check if route is public
  const isPublic = publicRoutes.some((route) => pathname === route || pathname.startsWith(route + '/'));
  console.log(`[Request] ${pathname} | Public: ${isPublic} | User: ${event.locals.user ? event.locals.user.username : 'Guest'}`);
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

