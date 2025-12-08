import type { PageServerLoad } from './$types';
import { getPublishedVideos } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 12;
  const filter = url.searchParams.get('filter') || 'all';
  
  // Only apply liked filter if user is logged in and filter is 'liked'
  const likedBy = (locals.user && filter === 'liked') ? locals.user.id : undefined;
  
  // Filter out NSFW content for non-logged-in users at database level
  const isNsfw = locals.user ? undefined : false;
  
  const result = await getPublishedVideos({ page, pageSize, likedBy, isNsfw });
  
  return { 
    videos: result.videos,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    filter,
    user: locals.user || null
  };
};
