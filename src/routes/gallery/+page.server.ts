import type { PageServerLoad } from './$types';
import { getPublishedVideos } from '$lib/db';

export const load: PageServerLoad = async ({ locals }) => {
  const videos = await getPublishedVideos();
  return { 
    videos,
    user: locals.user || null
  };
};
