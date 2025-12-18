import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAdminSettings, getSponsorClaimsByUser } from '$lib/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, '/login');
  }

  const settings = await getAdminSettings();
  const sponsorClaims = await getSponsorClaimsByUser(locals.user.id);

  return {
    user: locals.user,
    sponsorApiUrl: settings.sponsorApiUrl,
    sponsorApiToken: settings.sponsorApiToken,
    sponsorClaims,
  };
};
