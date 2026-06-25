import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  const sinceId = url.searchParams.get('since');
  if (!sinceId) {
    throw error(400, 'since parameter is required');
  }

  // Find the cursor video to compute "newer than" condition
  const cursorVideo = await db.getVideoById(sinceId);
  if (!cursorVideo) {
    // Video deleted — return a large count so the UI shows "many new videos"
    return json({ count: -1 });
  }

  // Count published videos that sort BEFORE the cursor in the feed order,
  // i.e. "newer" per the same [processingStartedAt DESC, createdAt DESC] used
  // by getPublishedVideos. Note: no isNsfw filter here, to match the short feed
  // which shows all videos to logged-in users (isNsfw: undefined).
  const psa = cursorVideo.processing_started_at
    ? new Date(cursorVideo.processing_started_at)
    : null;
  const cAt = new Date(cursorVideo.created_at);

  const newerThan = psa
    ? {
        OR: [
          { processingStartedAt: { gt: psa } },
          { processingStartedAt: psa, createdAt: { gt: cAt } },
        ],
      }
    : { createdAt: { gt: cAt } }; // cursor has no processing time → fall back to createdAt

  const count = await (db as any).prisma.video.count({
    where: {
      isPublished: true,
      status: { not: 'deleted' },
      ...newerThan,
    },
  });

  return json({ count });
};
