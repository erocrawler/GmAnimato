import type { RequestHandler } from '@sveltejs/kit';
import { updateUser, getAdminSettings, getSponsorClaimByUsername, createSponsorClaim, deleteSponsorClaim, updateSponsorClaim } from '$lib/db';
import { env } from '$env/dynamic/private';

interface SponsorData {
  fansNickname: string;
  fansAvatar: string;
  fansDomainName: string;
  schemeName: string;
}

interface SponsorClaimRequest {
  username: string;
}

interface SponsorClaimResponse {
  found: boolean;
  sponsor?: SponsorData;
  roleToApply?: string;
  message?: string;
  existingClaim?: any;
}

async function fetchSponsorFromCrawler(username: string): Promise<SponsorData | null> {
  try {
    // Get sponsor API config from settings, with env fallback
    const settings = await getAdminSettings();
    const crawlerUrl = settings.sponsorApiUrl || env.SPONSOR_API_URL || 'http://localhost:3999';
    const token = settings.sponsorApiToken || env.SPONSOR_API_TOKEN || '';

    if (!token) {
      console.warn('Sponsor API token not configured in settings or environment');
      return null;
    }

    const response = await fetch(`${crawlerUrl}/sponsors`, {
      headers: {
        Authorization: `${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch sponsors: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const sponsors = data.sponsors || [];

    // Find sponsor by fansDomainName (username match)
    const sponsor = sponsors.find(
      (s: any) => s.fansDomainName && s.fansDomainName.toLowerCase() === username.toLowerCase()
    );

    return sponsor || null;
  } catch (err) {
    console.error('Error fetching sponsor:', err);
    return null;
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = (await request.json()) as SponsorClaimRequest;
  const sponsorUsername = body.username?.trim();

  if (!sponsorUsername) {
    return new Response(
      JSON.stringify({ 
        messageCode: 'USERNAME_REQUIRED',
        found: false 
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Fetch sponsor data from GmCrawler first
    const sponsor = await fetchSponsorFromCrawler(sponsorUsername);

    if (!sponsor) {
      return new Response(
        JSON.stringify({
          found: false,
          messageCode: 'NOT_FOUND',
        } as SponsorClaimResponse),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if this sponsor has already been claimed by someone
    const existingClaim = await getSponsorClaimByUsername(sponsorUsername);
    
    if (existingClaim) {
      // Check if it was claimed by the current user
      if (existingClaim.user_id === locals.user.id) {
        // Get admin settings to find role mapping for current tier
        const settings = await getAdminSettings();
        const roleConfig = settings.roles?.find(
          (r: any) => r.sponsorTier && r.sponsorTier.toLowerCase() === sponsor.schemeName.toLowerCase()
        );
        const roleToApply = roleConfig?.name;

        // If expired, allow renewal
        if (existingClaim.expired_at) {
          return new Response(
            JSON.stringify({
              found: true,
              sponsor,
              roleToApply,
              existingClaim,
              messageCode: 'SPONSOR_RENEWED',
            } as SponsorClaimResponse),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            found: true,
            sponsor,
            roleToApply,
            existingClaim,
            messageCode: 'ALREADY_CLAIMED_BY_SELF',
            currentRole: existingClaim.applied_role,
          } as SponsorClaimResponse),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        // Only block if the existing claim is not expired
        if (!existingClaim.expired_at) {
          return new Response(
            JSON.stringify({
              found: false,
              messageCode: 'ALREADY_CLAIMED_BY_OTHER',
            } as SponsorClaimResponse),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // If expired by someone else, allow this user to claim it
      }
    }

    // Continue with new claim flow

    // Get admin settings to find role mapping
    const settings = await getAdminSettings();
    const roleConfig = settings.roles?.find(
      (r: any) => r.sponsorTier && r.sponsorTier.toLowerCase() === sponsor.schemeName.toLowerCase()
    );

    const roleToApply = roleConfig?.name;

    // Check if user already has this sponsor role
    const userRoles = locals.user.roles || [];
    if (roleToApply && userRoles.includes(roleToApply)) {
      return new Response(
        JSON.stringify({
          found: true,
          sponsor,
          messageCode: 'ALREADY_HAS_ROLE',
          role: roleToApply,
        } as SponsorClaimResponse),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        found: true,
        sponsor,
        roleToApply,
      } as SponsorClaimResponse),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error in sponsor claim:', err);
    return new Response(
      JSON.stringify({ 
        messageCode: 'SEARCH_FAILED',
        found: false 
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * Confirm sponsor claim and apply role to user
 */
export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = (await request.json()) as { username: string; roleToApply: string };
  const sponsorUsername = body.username?.trim();
  const roleToApply = body.roleToApply?.trim();

  if (!sponsorUsername || !roleToApply) {
    return new Response(
      JSON.stringify({ messageCode: 'USERNAME_REQUIRED' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Re-verify sponsor from GmCrawler first
    const sponsor = await fetchSponsorFromCrawler(sponsorUsername);

    if (!sponsor) {
      return new Response(
        JSON.stringify({ messageCode: 'VERIFICATION_FAILED' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get admin settings to validate role
    const settings = await getAdminSettings();
    const validRole = settings.roles?.find((r: any) => r.name === roleToApply);

    if (!validRole) {
      return new Response(
        JSON.stringify({ messageCode: 'INVALID_ROLE' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if this sponsor has already been claimed
    const existingClaim = await getSponsorClaimByUsername(sponsorUsername);
    
    if (existingClaim) {
      // Check if it was claimed by someone else (and not expired)
      if (existingClaim.user_id !== locals.user.id && !existingClaim.expired_at) {
        return new Response(
          JSON.stringify({ messageCode: 'ALREADY_CLAIMED_BY_OTHER' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
      // If expired and belongs to current user, renew it
      if (existingClaim.expired_at && existingClaim.user_id === locals.user.id) {
        // Restore the role if not present
        const currentRoles = locals.user.roles || [];
        if (!currentRoles.includes(roleToApply)) {
          currentRoles.push(roleToApply);
          const updated = await updateUser(locals.user.id, { roles: currentRoles });
          if (!updated) {
            return new Response(JSON.stringify({ 
              messageCode: 'UPDATE_ROLES_FAILED'
            }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        
        // Renew the claim by clearing expired_at and updating tier/role
        await updateSponsorClaim(existingClaim.id, { expired_at: null, sponsor_tier: sponsor.schemeName, applied_role: roleToApply });
        
        return new Response(
          JSON.stringify({
            success: true,
            messageCode: 'SPONSOR_RENEWED',
            role: roleToApply,
            user: {
              id: locals.user.id,
              username: locals.user.username,
              email: locals.user.email,
              roles: currentRoles,
              created_at: locals.user.created_at,
              updated_at: locals.user.updated_at,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      
      // If tier/role changed, remove old role and update claim in place
      if (existingClaim.user_id === locals.user.id && existingClaim.applied_role !== roleToApply) {
        const currentRoles = locals.user.roles || [];
        const updatedRoles = currentRoles.filter(r => r !== existingClaim.applied_role);
        if (!updatedRoles.includes(roleToApply)) {
          updatedRoles.push(roleToApply);
        }
        
        // Update user roles
        const updated = await updateUser(locals.user.id, { roles: updatedRoles });
        if (!updated) {
          return new Response(JSON.stringify({ 
            messageCode: 'UPDATE_ROLES_FAILED'
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        
        // Update existing claim with new tier and role
        await updateSponsorClaim(existingClaim.id, { sponsor_tier: sponsor.schemeName, applied_role: roleToApply });
        
        return new Response(
          JSON.stringify({
            success: true,
            messageCode: 'UPDATE_SUCCESS',
            role: roleToApply,
            user: {
              id: updated.id,
              username: updated.username,
              email: updated.email,
              roles: updated.roles,
              created_at: updated.created_at,
              updated_at: updated.updated_at,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        // Same role, no update needed
        return new Response(
          JSON.stringify({
            success: true,
            messageCode: 'NO_CHANGE_NEEDED',
            role: roleToApply,
            user: {
              id: locals.user.id,
              username: locals.user.username,
              email: locals.user.email,
              roles: locals.user.roles,
              created_at: locals.user.created_at,
              updated_at: locals.user.updated_at,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // New claim - update user roles
    const currentRoles = locals.user.roles || [];
    if (!currentRoles.includes(roleToApply)) {
      currentRoles.push(roleToApply);
    }

    const updated = await updateUser(locals.user.id, { roles: currentRoles });

    if (!updated) {
      return new Response(JSON.stringify({ 
        messageCode: 'UPDATE_ROLES_FAILED'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Store the sponsor claim to prevent duplicate claims
    await createSponsorClaim({
      user_id: locals.user.id,
      sponsor_username: sponsorUsername,
      sponsor_nickname: sponsor.fansNickname,
      sponsor_avatar: sponsor.fansAvatar,
      sponsor_tier: sponsor.schemeName,
      applied_role: roleToApply,
    });

    // Update session cookie with new user data
    const userPublic = {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      roles: updated.roles,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    };

    return new Response(
      JSON.stringify({
        success: true,
        messageCode: 'CLAIM_SUCCESS',
        role: roleToApply,
        user: userPublic,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error confirming sponsor claim:', err);
    return new Response(
      JSON.stringify({ messageCode: 'CLAIM_FAILED' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
