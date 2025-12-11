import type { PageServerLoad } from './$types';
import { getPublishedVideos } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 12;
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = (url.searchParams.get('sort') as 'date' | 'likes') || 'date';
  
  // Filter by liked videos only when filter is 'liked'
  const likedBy = (locals.user && filter === 'liked') ? locals.user.id : undefined;
  
  // Always pass current user ID to check like status
  const currentUserId = locals.user?.id;
  
  // Filter out NSFW content for non-logged-in users at database level
  const isNsfw = locals.user ? undefined : false;
  
  const result = await getPublishedVideos({ page, pageSize, likedBy, currentUserId, isNsfw, sortBy });
  
  return { 
    videos: result.videos,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    filter,
    sortBy,
    user: locals.user || null
  };
};
