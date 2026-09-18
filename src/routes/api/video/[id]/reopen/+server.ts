import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';

/**
 * Reopen a FAILED video for editing.
 *
 * Flips the entry back to the `uploaded` draft state so the review page becomes
 * editable again (prompt / settings can be tweaked and the job re-submitted).
 * Stale run + progress fields from the failed attempt are cleared so the review
 * page renders as a fresh draft.
 *
 * Only failed entries may be reopened — processing/in_queue/completed entries
 * are intentionally rejected so an in-flight or finished job can't be clobbered.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const id = params.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'missing id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const video = await getVideoById(id);
    if (!video) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isAdmin = locals.user.roles?.includes('admin');
    if (video.user_id !== locals.user.id && !isAdmin) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (video.status !== 'failed') {
      return new Response(
        JSON.stringify({ error: 'video is not in failed state' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // `null` (not `undefined`) is required to actually clear these columns —
    // updateVideo skips undefined patch fields on the Postgres backend.
    const updated = await updateVideo(id, {
      status: 'uploaded',
      progress_percentage: null,
      progress_details: null,
      processing_started_at: null,
      dequeued_at: null,
    } as any);

    if (!updated) {
      return new Response(
        JSON.stringify({ error: 'Failed to update video status' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ success: true, entry: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
