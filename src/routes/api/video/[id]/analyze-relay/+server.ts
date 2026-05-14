import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById, updateVideo } from '$lib/db';
import { generatePromptRelaySegments } from '$lib/imageRecognition';
import { toOriginalUrl } from '$lib/serverImageUrl';

export const POST: RequestHandler = async ({ params, request, locals }) => {
  try {
    if (!locals.user) {
      return new Response(JSON.stringify({ error: 'authentication required' }), {
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
      return new Response(JSON.stringify({ error: 'access denied' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json().catch(() => ({}));
    const totalFramesRaw = Number(body?.totalFrames);
    // Accept any 4n+1 value between 81 and 177; default to 81
    const totalFrames = (Number.isInteger(totalFramesRaw) && totalFramesRaw >= 81 && totalFramesRaw <= 177 && (totalFramesRaw - 1) % 4 === 0)
      ? totalFramesRaw
      : 81;
    const locale = typeof body?.locale === 'string' ? body.locale : 'en';

    const imageUrl = toOriginalUrl(video.original_image_url);
    const lastImageUrl = video.last_image_url ? toOriginalUrl(video.last_image_url) : undefined;

    const result = await generatePromptRelaySegments(
      imageUrl,
      lastImageUrl,
      totalFrames,
      18,
      locals.user.id,
      id,
      locale
    );

    if (!result) {
      return new Response(
        JSON.stringify({ error: 'analysis_unavailable', errorCode: 'analysis_unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Persist the generated segments immediately so they survive a page reload
    await updateVideo(id, {
      prompt: result.globalPrompt,
      additional_options: {
        ...(video.additional_options || {}),
        prompt_relay_mode: true,
        prompt_relay_segments: result.segments,
      },
    });

    return new Response(
      JSON.stringify({ success: true, globalPrompt: result.globalPrompt, segments: result.segments }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[analyze-relay] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
