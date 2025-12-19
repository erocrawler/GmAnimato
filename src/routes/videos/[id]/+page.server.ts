import type { PageServerLoad } from './$types';
import { getVideoById, getLikeCount, isVideoLikedByUser, getWorkflowById, getAdminSettings } from '$lib/db';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  const video = await getVideoById(params.id);
  
  if (!video) {
    throw error(404, 'Video not found');
  }

  // Only allow owner or admin to view the video
  const isAdmin = locals.user.roles?.includes('admin');
  if (video.user_id !== locals.user.id && !isAdmin) {
    throw error(403, 'Forbidden');
  }

  // Get like information
  const likesCount = await getLikeCount(video.id);
  const isLiked = await isVideoLikedByUser(video.id, locals.user.id);
  
  // Fetch workflow info if available
  const workflow = video.workflow_id ? await getWorkflowById(video.workflow_id) : null;
  
  // Fetch admin settings to get LoRA presets for display names
  const settings = await getAdminSettings();
  
  return {
    video: { ...video, likesCount, isLiked },
    user: locals.user,
    workflow,
    loraPresets: settings.loraPresets || [],
  };
};
