import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAllVideos } from '$lib/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  // Check if user is logged in and is admin
  if (!locals.user) {
    throw redirect(303, '/login');
  }

  if (!locals.user.roles?.includes('admin')) {
    throw redirect(303, '/');
  }

  const page = parseInt(url.searchParams.get('page') || '1');
  const pageSize = 30;
  const statusFilter = url.searchParams.get('status') || undefined;
  const userFilter = url.searchParams.get('user') || undefined;

  // Use the optimized getAllVideos function with filters
  const result = await getAllVideos({
    page,
    pageSize,
    status: statusFilter as any,
    username: userFilter,
    includeDeleted: true
  });

  return {
    videos: result.videos,
    page: result.page,
    totalPages: result.totalPages,
    total: result.total,
    pageSize: result.pageSize,
    statusFilter: statusFilter || '',
    userFilter: userFilter || '',
  };
};
