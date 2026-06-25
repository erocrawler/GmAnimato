import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAllVideos, getVideoModelTypes } from '$lib/db';

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
  // modelType is a multi-select filter; accept repeated params or comma-separated values
  const modelTypeParams = url.searchParams.getAll('modelType');
  let modelTypeFilter: string[] = [];
  if (modelTypeParams.length > 0) {
    modelTypeFilter = modelTypeParams
      .flatMap((p) => p.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Fetch the distinct model types present in the video table (includes legacy/unavailable)
  const modelTypes = await getVideoModelTypes();

  // Use the optimized getAllVideos function with filters
  const result = await getAllVideos({
    page,
    pageSize,
    status: statusFilter as any,
    username: userFilter,
    modelTypeIds: modelTypeFilter.length > 0 ? modelTypeFilter : undefined,
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
    modelTypeFilter,
    modelTypes,
  };
};
