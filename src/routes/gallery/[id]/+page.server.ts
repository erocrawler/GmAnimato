import type { PageServerLoad } from './$types';
import { getVideoById, getPublishedVideos, getUserById, getLikeCount, isVideoLikedByUser } from '$lib/db';
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

  // Get like information
  const likesCount = await getLikeCount(video.id);
  const isLiked = locals.user ? await isVideoLikedByUser(video.id, locals.user.id) : false;

  // Get other published videos for "More Videos" section (exclude current video, only completed)
  const relatedVideosPage = await getPublishedVideos({
    page: 1,
    pageSize: 4,
    excludeId: params.id,
    status: 'completed'
  });
  const relatedVideos = relatedVideosPage.videos;

  // Fetch author basic info
  const author = video.user_id ? await getUserById(video.user_id) : undefined;
  const authorPublic = author
    ? {
        id: author.id,
        username: author.username,
      }
    : null;
  
  return {
    video: { ...video, likesCount, isLiked },
    user: locals.user || null,
    relatedVideos,
    author: authorPublic,
  };
};
