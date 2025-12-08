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

  // Get other published videos for "More Videos" section (exclude current video, only completed)
  const relatedVideosPage = await getPublishedVideos({
    page: 1,
    pageSize: 4,
    excludeId: params.id,
    status: 'completed'
  });
  const relatedVideos = relatedVideosPage.videos;
  
  return {
    video,
    user: locals.user || null,
    relatedVideos
  };
};
