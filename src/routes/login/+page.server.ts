import type { PageServerLoad } from './$types';
import { getAdminSettings } from '$lib/db';

export const load: PageServerLoad = async () => {
  const settings = await getAdminSettings();
  
  return {
    registrationEnabled: settings.registrationEnabled,
  };
};
