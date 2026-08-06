import type { RequestHandler } from '@sveltejs/kit';
import { updateUser, getSponsorClaimsByUser, createSponsorClaim, updateSponsorClaim, deleteSponsorClaimsForRole } from '$lib/db';

/** Manual claim sponsor_username convention: manual:<userId>:<role> (unique per user+role). */
function manualClaimUsername(userId: string, role: string): string {
  return `manual:${userId}:${role}`;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userId = params.id!;
  const claims = await getSponsorClaimsByUser(userId);
  // Return current roles + any manual expirations for the edit modal
  const expirations: Record<string, string | null> = {};
  for (const claim of claims) {
    if (claim.claim_type === 'manual') {
      expirations[claim.applied_role] = claim.expired_at || null;
    }
  }
  return new Response(JSON.stringify({ expirations }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  // Check if user is admin
  if (!locals.user?.roles?.includes('admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userId = params.id!;
  const body = await request.json();
  
  if (!body.roles || !Array.isArray(body.roles)) {
    return new Response(JSON.stringify({ error: 'Invalid roles' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const roles: string[] = body.roles.map((r: unknown) => String(r).trim()).filter(Boolean);
  const expirations: Record<string, string | null> = body.expirations && typeof body.expirations === 'object'
    ? body.expirations
    : {};

  // Validate expirations values (ISO dates or null)
  for (const [role, expiry] of Object.entries(expirations)) {
    if (expiry !== null && typeof expiry === 'string' && Number.isNaN(Date.parse(expiry))) {
      return new Response(JSON.stringify({ error: `Invalid expiration for role ${role}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const updated = await updateUser(userId, { roles });
  
  if (!updated) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Reconcile manual claims (the expiry mechanism, reusing SponsorClaim):
  // - role with a future/past expiry  -> upsert manual claim with expired_at
  // - role with null/absent expiry    -> no manual claim needed (permanent role)
  // - removed role with manual claim  -> delete the claim
  const claims = await getSponsorClaimsByUser(userId);
  const existingManual = claims.filter((c) => c.claim_type === 'manual');

  for (const role of roles) {
    const expiry = expirations[role];
    const existing = existingManual.find((c) => c.applied_role === role);

    if (expiry && typeof expiry === 'string') {
      const username = manualClaimUsername(userId, role);
      if (existing) {
        await updateSponsorClaim(existing.id, { expired_at: expiry });
      } else {
        await createSponsorClaim({
          user_id: userId,
          sponsor_username: username,
          sponsor_tier: 'manual',
          applied_role: role,
          claim_type: 'manual',
        } as any).then((claim) => updateSponsorClaim(claim.id, { expired_at: expiry }));
      }
    } else {
      // No expiry -> permanent role; drop any manual claim for it
      if (existing) {
        await deleteSponsorClaimsForRole(userId, role);
      }
    }
  }

  // Clean up manual claims for roles that were removed entirely
  for (const claim of existingManual) {
    if (!roles.includes(claim.applied_role)) {
      await deleteSponsorClaimsForRole(userId, claim.applied_role);
    }
  }

  return new Response(JSON.stringify({ success: true, user: updated }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
