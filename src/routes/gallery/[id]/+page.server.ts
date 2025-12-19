import type { PageServerLoad } from './$types';
import { getVideoById, getPublishedVideos, getUserById, getLikeCount, isVideoLikedByUser, getWorkflowById, getAdminSettings } from '$lib/db';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const video = await getVideoById(params.id);
  if (!video) {
    throw error(404, 'Video not found');
  }
  // Only show published videos in gallery
  if (!video.is_published) {
    throw error(404, 'Video not found');
  }
  // Block unregistered users from viewing NSFW content
  if (!locals.user && video.is_nsfw) {
    throw error(403, 'This content requires authentication');
  }

  // Get like information
  const likesCount = await getLikeCount(video.id);
  const isLiked = locals.user ? await isVideoLikedByUser(video.id, locals.user.id) : false;

  // Determine sort order and page from query or default
  const sortBy = (url?.searchParams?.get('sort') as 'date' | 'likes') || 'date';
  const page = parseInt(url?.searchParams?.get('page') || '1', 10);
  const pageSize = 12; // match your gallery page size

  // Filter out NSFW content for non-logged-in users
  const isNsfw = locals.user ? undefined : false;

  // Fetch current and next page
  const videosPage1 = await getPublishedVideos({
    page,
    pageSize,
    status: 'completed',
    sortBy,
    isNsfw
  });
  const videosPage2 = await getPublishedVideos({
    page: page + 1,
    pageSize,
    status: 'completed',
    sortBy,
    isNsfw
  });
  const allVideos = [...videosPage1.videos, ...videosPage2.videos];
  const currentIdx = allVideos.findIndex(v => v.id === params.id);
  const relatedVideos = currentIdx !== -1 ? allVideos.slice(currentIdx + 1, currentIdx + 5) : allVideos.slice(0, 4);

  // Fetch author basic info
  const author = video.user_id ? await getUserById(video.user_id) : undefined;
  const authorPublic = author
    ? {
        id: author.id,
        username: author.username,
      }
    : null;
  
  // Fetch workflow info if available
  const workflow = video.workflow_id ? await getWorkflowById(video.workflow_id) : null;
  
  // Fetch admin settings to get LoRA presets for display names
  const settings = await getAdminSettings();
  
  return {
    video: { ...video, likesCount, isLiked },
    user: locals.user || null,
    relatedVideos,
    author: authorPublic,
    workflow,
    loraPresets: settings.loraPresets || [],
  };
};
