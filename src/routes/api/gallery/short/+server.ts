import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPublishedVideos, getGalleryState, setGalleryState } from '$lib/db';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 30);
  const afterId = url.searchParams.get('after') || undefined;
  const aroundId = url.searchParams.get('around') || undefined;
  const sortBy = (url.searchParams.get('sort') as 'date' | 'likes') || 'date';
  const filter = url.searchParams.get('filter') || 'all';

  const likedBy = filter === 'liked' ? locals.user.id : undefined;
  const isNsfw = undefined;

  // Determine cursor mode
  let startAtId: string | undefined;
  let afterValue: string | undefined;

  if (aroundId) {
    // "Resume position" — start from this video (inclusive)
    startAtId = aroundId;
  } else {
    afterValue = afterId;
  }

  const result = await getPublishedVideos({
    page: 1,
    pageSize: limit,
    likedBy,
    currentUserId: locals.user.id,
    isNsfw,
    sortBy,
    afterValue,
    startAtId,
  });

  return json({
    videos: result.videos,
    hasMore: result.page < result.totalPages,
  });
};

// Save gallery state (last viewed position, history, etc.)
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  const body = await request.json();
  const { lastVideoId, newestSeenId, history } = body;

  // Merge with existing state
  const existing = await getGalleryState(locals.user.id) || {};
  const newState = {
    ...existing,
    lastVideoAt: new Date().toISOString(),
    lastVideoId: lastVideoId ?? existing.lastVideoId,
    newestSeenId: newestSeenId ?? existing.newestSeenId,
    lastVisitAt: new Date().toISOString(),
    history: history ?? existing.history,
  };

  // Cap history at 20 entries
  if (newState.history && newState.history.length > 20) {
    newState.history = newState.history.slice(0, 20);
  }

  await setGalleryState(locals.user.id, newState);
  return json({ ok: true });
};
