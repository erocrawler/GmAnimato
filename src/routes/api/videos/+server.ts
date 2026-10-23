import type { RequestHandler } from '@sveltejs/kit';
import { getVideosByUser } from '$lib/db';
import type { GetVideosByUserOptions } from '$lib/db';
import { errorResponse, intParam, jsonResponse, serializeVideoSummary } from '$lib/agentApi';

const STATUSES = ['uploaded', 'in_queue', 'processing', 'completed', 'failed'] as const;
const MAX_PAGE_SIZE = 50;

/**
 * GET /api/videos?page=1&page_size=15[&status=completed][&sort=upload|completion][&direction=asc|desc]
 * The caller's own videos (deleted ones excluded), newest first by default.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) return errorResponse(401, 'Authentication required', 'unauthenticated');

  const page = intParam(url.searchParams.get('page'), 1, 1, 100000);
  const pageSize = intParam(url.searchParams.get('page_size'), 15, 1, MAX_PAGE_SIZE);

  const options: GetVideosByUserOptions = {};
  const status = url.searchParams.get('status');
  if (status) {
    if (!(STATUSES as readonly string[]).includes(status)) {
      return errorResponse(400, `status must be one of ${STATUSES.join(', ')}`, 'invalid_status');
    }
    options.status = status as GetVideosByUserOptions['status'];
  }
  const sort = url.searchParams.get('sort') ?? 'upload';
  if (sort !== 'upload' && sort !== 'completion') return errorResponse(400, 'sort must be upload or completion', 'invalid_sort');
  options.sortBy = sort;
  const direction = url.searchParams.get('direction') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') return errorResponse(400, 'direction must be asc or desc', 'invalid_direction');
  options.sortDirection = direction;

  const result = await getVideosByUser(locals.user.id, page, pageSize, options);
  return jsonResponse({
    videos: result.videos.map(serializeVideoSummary),
    page: result.page,
    page_size: result.pageSize,
    total: result.total,
    total_pages: result.totalPages,
  });
};
