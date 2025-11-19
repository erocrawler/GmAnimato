import type { PageServerLoad } from './$types';
import { getVideoById, getPublishedVideos } from '$lib/db';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params, locals }) => {
  const video = await getVideoById(params.id);
  
  if (!video) {
    throw error(404, 'Video not found');
  }

  // Only show published videos in gallery
  if (!video.is_published) {
    throw error(404, 'Video not found');
  }

  // Get other published videos for "More Videos" section
  const allPublishedVideos = await getPublishedVideos();
  const relatedVideos = allPublishedVideos
    .filter(v => v.id !== params.id && v.status === 'completed')
    .slice(0, 4); // Show up to 4 related videos
  
  return {
    video,
    user: locals.user || null,
    relatedVideos
  };
};
