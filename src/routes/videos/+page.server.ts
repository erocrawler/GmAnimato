import type { PageServerLoad } from './$types';
import { getVideosByUser } from '$lib/db';
import type { GetVideosByUserOptions } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) return { videos: [], total: 0, page: 1, pageSize: 15, totalPages: 0, sortBy: 'completion', sortDirection: 'desc', statusFilter: 'all' };
  
  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 15;
  
  // Parse sort and filter parameters
  const sortBy = (url.searchParams.get('sortBy') || 'completion') as 'upload' | 'completion';
  const sortDirection = (url.searchParams.get('sortDirection') || 'desc') as 'asc' | 'desc';
  const statusFilter = url.searchParams.get('statusFilter') || 'all';
  
  const options: GetVideosByUserOptions = {
    sortBy,
    sortDirection,
  };
  
  // Parse combined status filter
  if (statusFilter !== 'all') {
    if (statusFilter === 'completed-published') {
      options.status = 'completed';
      options.isPublished = true;
    } else if (statusFilter === 'completed-unpublished') {
      options.status = 'completed';
      options.isPublished = false;
    } else if (['uploaded', 'in_queue', 'processing', 'completed', 'failed'].includes(statusFilter)) {
      options.status = statusFilter as any;
    }
  }
  
  const result = await getVideosByUser(locals.user.id, page, pageSize, options);
  
  return {
    videos: result.videos,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    sortBy,
    sortDirection,
    statusFilter
  };
};
