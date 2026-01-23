import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getVideoById, getAdminSettings, getWorkflows } from '$lib/db';
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
  
  // Check if user has advanced features enabled through any of their roles
  let hasAdvancedFeatures = false;
  if (locals.user && adminSettings.roles) {
    hasAdvancedFeatures = locals.user.roles.some(userRole => {
      const roleConfig = adminSettings.roles?.find(r => r.name === userRole);
      return roleConfig?.allowAdvancedFeatures === true;
    });
  }
  
  // Load workflows directly instead of requiring client-side fetch
  const workflows = await getWorkflows();
  
  return { 
    entry, 
    loraPresets: normalizeLoraPresets(adminSettings.loraPresets),
    hasAdvancedFeatures,
    sponsorUrl: env.SPONSOR_URL,
    workflows
  } as any;
};
