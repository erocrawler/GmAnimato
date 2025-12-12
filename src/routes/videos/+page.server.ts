import type { PageServerLoad } from './$types';
import { getVideosByUser } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) return { videos: [], total: 0, page: 1, pageSize: 15, totalPages: 0 };
  
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 15;
  
  const result = await getVideosByUser(locals.user.id, page, pageSize);
  
  return {
    videos: result.videos,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages
  };
};
