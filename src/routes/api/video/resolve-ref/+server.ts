import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById } from '$lib/db';
import { toProxiedUrl } from '$lib/serverImageUrl';

/**
 * POST /api/video/resolve-ref
 *
 * Resolve a video page URL / ID to its reusable final video file URL, for the
 * ref2v "reuse video" input. Accepts any of:
 *   https://animato.gmgard.moe/videos/<id>
 *   /videos/<id>
 *   /gallery/<id>
 *   /<id>            (bare cuid)
 *   https://.../<id>
 *
 * Body: { url: string }
 * Response: { success: true, id, url (proxied /media/...), name } | { error }
 *
 * Access: the video must be completed and have a final_video_url, and must be
 * either owned by the caller, an admin, or published (gallery-visible).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => ({}));
    const raw = String(body?.url ?? '').trim();
    if (!raw) {
      return new Response(JSON.stringify({ error: 'empty url' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract the video id from the accepted URL forms.
    //  - /videos/<id> or /gallery/<id> (relative or absolute)
    //  - /<id> or a bare cuid-looking token
    let id: string | null = null;
    const pageMatch = raw.match(/\/(?:videos|gallery)\/([a-z0-9]+)(?:\?|#|$)/i);
    if (pageMatch) {
      id = pageMatch[1];
    } else {
      // Strip query/hash, then take the last path segment; accept bare c-ids
      // (cuid: starts with 'c', 24+ alnum) or a trailing segment that is one.
      const cleaned = raw.split(/[?#]/)[0].replace(/\/+$/, '');
      const lastSeg = cleaned.split('/').pop() || '';
      if (/^[a-z0-9]{20,}$/i.test(lastSeg)) {
        id = lastSeg;
      }
    }
    if (!id) {
      return new Response(JSON.stringify({ error: 'could not parse video id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const video = await getVideoById(id);
    if (!video) {
      return new Response(JSON.stringify({ error: 'video not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Must be a completed video with a downloadable file.
    if (video.status !== 'completed' || !video.final_video_url) {
      return new Response(
        JSON.stringify({ error: 'video is not ready to reuse (not completed)' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Access: own video, admin, or published (gallery-visible).
    const isAdmin = locals.user.roles?.includes('admin');
    if (video.user_id !== locals.user.id && !isAdmin && !video.is_published) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Return the proxied URL so the browser can load it same-origin (no CORS).
    const proxied = toProxiedUrl(video.final_video_url);
    const name = video.final_video_url.split('/').pop() || 'ref_video.mp4';

    return new Response(
      JSON.stringify({ success: true, id: video.id, url: proxied, name }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[resolve-ref] Error:', err);
    return new Response(JSON.stringify({ error: 'failed to resolve video' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
