import type { PageServerLoad } from './$types';
import { getVideoById } from '$lib/db';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  const video = await getVideoById(params.id);
  
  if (!video) {
    throw error(404, 'Video not found');
  }

  // Only allow owner to view their video
  if (video.user_id !== locals.user.id) {
    throw error(403, 'Forbidden');
  }
  
  return {
    video,
    user: locals.user
  };
};
