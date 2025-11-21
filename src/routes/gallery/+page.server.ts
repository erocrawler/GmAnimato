import type { PageServerLoad } from './$types';
import { getPublishedVideos } from '$lib/db';

export const load: PageServerLoad = async ({ locals }) => {
  const allVideos = await getPublishedVideos();
  
  // Filter out NSFW content for non-logged-in users
  const videos = locals.user 
    ? allVideos 
    : allVideos.filter(v => !v.is_nsfw);
  
  return { 
    videos,
    user: locals.user || null
  };
};
