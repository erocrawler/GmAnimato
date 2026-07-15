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

  // Preserve sort + filter from list page: ?sort=likes&page=2&filter=liked
  const sortBy = (url?.searchParams?.get('sort') as 'date' | 'likes') || 'date';
  const filter = url?.searchParams?.get('filter') || 'all';
  const likedBy = locals.user && filter === 'liked' ? locals.user.id : undefined;

  // Filter out NSFW content for non-logged-in users
  const isNsfw = locals.user ? undefined : false;

  // Related / next-in-feed — now works for both date and likes thanks to likesCountCache + trigger
  const relatedVideos = (
    await getPublishedVideos({
      pageSize: 4,
      status: 'completed',
      sortBy,
      isNsfw,
      likedBy,
      currentUserId: locals.user?.id,
      afterValue: params.id,
      excludeId: params.id,
    })
  ).videos;

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
