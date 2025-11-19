import type { PageServerLoad } from './$types';
import { getVideoById } from '$lib/db';

export const load: PageServerLoad = async ({ params, locals }) => {
  const id = params.id;
  const entry = await getVideoById(id);
  if (!entry) return { status: 404 } as any;
  // Basic ownership check if user is available
  if (locals.user && entry.user_id !== locals.user.id) return { status: 403 } as any;
  return { entry } as any;
};
