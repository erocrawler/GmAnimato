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

  // Determine sort order from query or default
  const sortBy = (url?.searchParams?.get('sort') as 'date' | 'likes') || 'date';

  // Filter out NSFW content for non-logged-in users
  const isNsfw = locals.user ? undefined : false;

  // Get 4 videos that come after this one in the sort order (for "related" sidebar)
  const relatedResult = await getPublishedVideos({
    pageSize: 4,
    status: 'completed',
    sortBy,
    isNsfw,
    afterValue: params.id,
    excludeId: params.id,
  });
  const relatedVideos = relatedResult.videos;

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
