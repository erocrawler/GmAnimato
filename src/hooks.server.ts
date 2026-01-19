import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getSessionByToken, getUserById, deleteSession, deleteExpiredSessions, getAllSponsorClaims, deleteSponsorClaim, expireSponsorClaim, updateSponsorClaim, updateUser, getAdminSettings } from '$lib/db';
import { isSessionExpired } from '$lib/session';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';

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

async function revalidateSponsors() {
  try {
    console.log('[Background Tasks] Revalidating sponsor claims...');
    
    // Get all sponsor claims from database (including expired ones to check for renewals)
    const claims = await getAllSponsorClaims();
    
    if (claims.length === 0) {
      console.log('[Background Tasks] No sponsor claims to validate');
      return;
    }

    // Fetch current sponsors from API
    const settings = await getAdminSettings();
    const sponsorApiUrl = settings.sponsorApiUrl || env.SPONSOR_API_URL || 'http://localhost:3999';
    const sponsorToken = settings.sponsorApiToken || env.SPONSOR_API_TOKEN;
    
    if (!sponsorToken) {
      console.error('[Background Tasks] Sponsor API token not configured in settings or environment, skipping sponsor validation');
      return;
    }

    const response = await fetch(`${sponsorApiUrl}/sponsors`, {
      headers: {
        'Authorization': `${sponsorToken}`
      }
    });

    if (!response.ok) {
      console.error(`[Background Tasks] Failed to fetch sponsors: ${response.status}`);
      return;
    }

    const data = await response.json();
    const currentSponsors = data.sponsors || [];
    
    // Create a map of current sponsors by username
    const sponsorMap = new Map<string, { tier: string; status: string }>(
      currentSponsors.map((s: any) => [
        s.fansDomainName?.toLowerCase(),
        { tier: s.schemeName, status: s.status }
      ])
    );
    
    // Get role configuration
    const roles = (settings.roles || []) as Array<{ name: string; sponsorTier?: string }>;
    const tierToRoleMap = new Map<string, string>();
    roles.forEach(role => {
      if (role.sponsorTier) {
        tierToRoleMap.set(role.sponsorTier, role.name);
      }
    });
    
    let expiredCount = 0;
    let updatedCount = 0;
    let renewedCount = 0;

    // Check each claim against current sponsors
    for (const claim of claims) {
      const sponsorInfo = sponsorMap.get(claim.sponsor_username.toLowerCase());
      
      if (!sponsorInfo) {
        // Sponsor no longer exists - mark as expired and remove role (if not already expired)
        if (!claim.expired_at) {
          console.log(`[Background Tasks] Sponsor no longer exists: ${claim.sponsor_username} (user: ${claim.user_id})`);
          
          const user = await getUserById(claim.user_id);
          if (user) {
            const updatedRoles = user.roles.filter(r => r !== claim.applied_role);
            await updateUser(claim.user_id, { roles: updatedRoles });
            console.log(`[Background Tasks] Removed role '${claim.applied_role}' from user ${user.username}`);
          }
          
          await expireSponsorClaim(claim.id);
          expiredCount++;
        }
      } else {
        // Sponsor exists - check if it was expired and needs renewal
        if (claim.expired_at) {
          console.log(`[Background Tasks] Sponsor renewed: ${claim.sponsor_username} (user: ${claim.user_id})`);
          
          // Check if tier matches
          const expectedRole = tierToRoleMap.get(sponsorInfo.tier);
          if (expectedRole) {
            const user = await getUserById(claim.user_id);
            if (user) {
              // Restore the role if not present
              if (!user.roles.includes(expectedRole)) {
                const updatedRoles = [...user.roles, expectedRole];
                await updateUser(claim.user_id, { roles: updatedRoles });
                console.log(`[Background Tasks] Restored role '${expectedRole}' to user ${user.username}`);
              }
            }
            
            // Un-expire the claim and align tier/role
            await updateSponsorClaim(claim.id, { expired_at: null });
            if (sponsorInfo.tier !== claim.sponsor_tier && expectedRole) {
              await updateSponsorClaim(claim.id, { sponsor_tier: sponsorInfo.tier, applied_role: expectedRole });
              updatedCount++;
            }
            renewedCount++;
          }
        } else if (sponsorInfo.tier !== claim.sponsor_tier) {
          // Tier changed - update role
          const newRole = tierToRoleMap.get(sponsorInfo.tier);
          
          if (!newRole) {
            // New tier has no role mapping - mark as expired
            console.log(`[Background Tasks] Sponsor tier changed to unmapped tier: ${claim.sponsor_username} (${claim.sponsor_tier} → ${sponsorInfo.tier})`);
            
            const user = await getUserById(claim.user_id);
            if (user) {
              const updatedRoles = user.roles.filter(r => r !== claim.applied_role);
              await updateUser(claim.user_id, { roles: updatedRoles });
              console.log(`[Background Tasks] Removed role '${claim.applied_role}' from user ${user.username}`);
            }
            
            await expireSponsorClaim(claim.id);
            expiredCount++;
          } else {
            // Update to new role
            console.log(`[Background Tasks] Sponsor tier changed: ${claim.sponsor_username} (${claim.sponsor_tier} → ${sponsorInfo.tier})`);
            
            const user = await getUserById(claim.user_id);
            if (user) {
              // Remove old role and add new role
              let updatedRoles = user.roles.filter(r => r !== claim.applied_role);
              if (!updatedRoles.includes(newRole)) {
                updatedRoles.push(newRole);
              }
              await updateUser(claim.user_id, { roles: updatedRoles });
              console.log(`[Background Tasks] Updated user ${user.username}: role '${claim.applied_role}' → '${newRole}'`);
            }
            
            // Update the claim record with new tier and role
            const updated = await updateSponsorClaim(claim.id, { sponsor_tier: sponsorInfo.tier, applied_role: newRole });
            if (updated) {
              updatedCount++;
            }
          }
        }
      }
    }
    
    console.log(`[Background Tasks] Sponsor validation complete: ${expiredCount} expired, ${updatedCount} tier changes, ${renewedCount} renewed`);
  } catch (err) {
    console.error('[Background Tasks] Sponsor revalidation error:', err);
  }
}

async function runCleanup() {
  try {
    console.log('[Background Tasks] Running cleanup tasks...');
    
    // Clean up expired sessions
    console.log('[Background Tasks] Running session cleanup...');
    const deleted = await deleteExpiredSessions();
    console.log(`[Background Tasks] Deleted ${deleted} expired sessions`);
    
    // Revalidate sponsor claims
    await revalidateSponsors();
  } catch (err) {
    console.error('[Background Tasks] Cleanup error:', err);
  }
}

// Initialize background tasks on server start (not during build)
if (!building) {
  console.log('[Background Tasks] Server started: Initializing...');
  // Run cleanup tasks immediately on startup
  runCleanup().catch(err => console.error('[Background Tasks] Initial cleanup error:', err));
  // Then schedule for regular intervals
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
    '/api/worker/task',
    '/auth/gmgard',
    '/auth/gmgard/callback'
  ];
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

