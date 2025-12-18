import type { RequestHandler } from '@sveltejs/kit';
import { updateUser, getAdminSettings, getSponsorClaimByUsername, createSponsorClaim } from '$lib/db';
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
      JSON.stringify({ error: 'Username is required', found: false }),
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
          message: 'Sponsor not found. Please verify the username.',
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

        return new Response(
          JSON.stringify({
            found: true,
            sponsor,
            roleToApply,
            existingClaim,
            message: `You have already claimed this sponsor. You currently have the "${existingClaim.applied_role}" role.`,
          } as SponsorClaimResponse),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        return new Response(
          JSON.stringify({
            found: false,
            message: 'This sponsor has already been claimed by another user.',
          } as SponsorClaimResponse),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
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
          message: `You already have the "${roleToApply}" role from this sponsor tier.`,
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
      JSON.stringify({ error: 'Failed to verify sponsor', found: false }),
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
      JSON.stringify({ error: 'Username and roleToApply are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Check if this sponsor has already been claimed
    const existingClaim = await getSponsorClaimByUsername(sponsorUsername);
    
    if (existingClaim) {
      // Check if it was claimed by the current user
      if (existingClaim.user_id !== locals.user.id) {
        return new Response(
          JSON.stringify({ error: 'This sponsor has already been claimed by another user' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // If already claimed by this user, just return success
      return new Response(
        JSON.stringify({
          success: true,
          message: `You have already claimed this sponsor with the "${existingClaim.applied_role}" role.`,
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

    // Re-verify sponsor from GmCrawler
    const sponsor = await fetchSponsorFromCrawler(sponsorUsername);

    if (!sponsor) {
      return new Response(
        JSON.stringify({ error: 'Sponsor verification failed' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get admin settings to validate role
    const settings = await getAdminSettings();
    const validRole = settings.roles?.find((r: any) => r.name === roleToApply);

    if (!validRole) {
      return new Response(
        JSON.stringify({ error: 'Invalid role' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Update user roles
    const currentRoles = locals.user.roles || [];
    if (!currentRoles.includes(roleToApply)) {
      currentRoles.push(roleToApply);
    }

    const updated = await updateUser(locals.user.id, { roles: currentRoles });

    if (!updated) {
      return new Response(JSON.stringify({ error: 'Failed to update user roles' }), {
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

    cookies.set('session', JSON.stringify(userPublic), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully claimed ${roleToApply} role!`,
        user: userPublic,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error confirming sponsor claim:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to process sponsor claim' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
