import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getVideoById, getAdminSettings } from '$lib/db';
import { normalizeLoraPresets } from '$lib/loraPresets';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ params, locals }) => {
  const id = params.id;
  const entry = await getVideoById(id);
  if (!entry) throw error(404, 'Video not found');
  // Basic ownership check if user is available (admins can view any video)
  const isAdmin = locals.user?.roles?.includes('admin');
  if (locals.user && entry.user_id !== locals.user.id && !isAdmin) throw error(403, 'Access denied');
  const adminSettings = await getAdminSettings();
  return { 
    entry, 
    loraPresets: normalizeLoraPresets(adminSettings.loraPresets),
    userRoles: locals.user?.roles || [],
    sponsorUrl: env.SPONSOR_URL
  } as any;
};
