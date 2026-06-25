import type { PageServerLoad } from './$types';
import { getPublishedVideos, getGalleryState } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 12;
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = (url.searchParams.get('sort') as 'date' | 'likes') || 'date';
  const modeParam = url.searchParams.get('mode');
  const mode = (modeParam === 'short') ? 'short' : null;
  
  // Filter by liked videos only when filter is 'liked'
  const likedBy = (locals.user && filter === 'liked') ? locals.user.id : undefined;
  
  // Always pass current user ID to check like status
  const currentUserId = locals.user?.id;
  
  // Filter out NSFW content for non-logged-in users at database level
  const isNsfw = locals.user ? undefined : false;

  // For short mode, start from a specific video (from= param) or the user's saved position
  let startAtId: string | undefined;
  if (mode === 'short') {
    const fromParam = url.searchParams.get('from');
    if (fromParam) {
      startAtId = fromParam;
    } else if (locals.user) {
      const galleryState = await getGalleryState(locals.user.id);
      if (galleryState?.lastVideoId) startAtId = galleryState.lastVideoId;
    }
  }
  
  const result = await getPublishedVideos({ page, pageSize, likedBy, currentUserId, isNsfw, sortBy, startAtId });

  // Fetch gallery state for the user (positions, new-video tracking, history)
  const galleryState = locals.user ? await getGalleryState(locals.user.id) : null;
  
  return { 
    videos: result.videos,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    filter,
    sortBy,
    mode,
    user: locals.user || null,
    galleryState,
  };
};
