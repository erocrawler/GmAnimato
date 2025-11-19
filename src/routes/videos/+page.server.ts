import type { PageServerLoad } from './$types';
import { getVideosByUser } from '$lib/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { videos: [] };
  const videos = await getVideosByUser(locals.user.id);
  // Sort by created_at descending (newest first)
  videos.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return { videos };
};
