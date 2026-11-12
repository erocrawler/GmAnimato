import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById } from '$lib/db';
import { enhanceMiniMaxPrompt } from '$lib/imageRecognition';
import { collectLabeledReferenceImages, detectReferenceWorkflowType } from '$lib/referenceImages';

/**
 * POST /api/video/[id]/enhance-prompt
 *
 * Rewrite a simple MiniMax H3 prompt into the structured prompt format the
 * generation nodes consume (integrated_multimodal_description etc.) using the
 * CUSTOM_VL vision-language endpoint. The enhancer runs UI-side only — it is
 * never part of the job workflow.
 *
 * Body: { prompt?: string; workflowType?: 'ref2v'|'fl2v'|'i2v';
 *         videoDuration?: number; locale?: 'zh'|'en' }
 * Response: { success: true, enhancedPrompt: string }
 */
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

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // empty body — fall back to entry defaults
    }

    const prompt = String(body.prompt ?? video.prompt ?? '').trim();
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'empty prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const workflowType = detectReferenceWorkflowType(video, String(body.workflowType ?? ''));

    // Labeled reference images for vision grounding (shared with the analyze endpoint).
    const filteredLabeled = await collectLabeledReferenceImages(video, workflowType);

    const durationSeconds = Number(body.videoDuration ?? video.video_duration ?? 5);

    const enhancedPrompt = await enhanceMiniMaxPrompt({
      prompt,
      workflowType,
      labeledImages: filteredLabeled,
      hasStandaloneAudio: workflowType === 'ref2v'
        ? Boolean(video.additional_options?.ref_audio_url)
        : false,
      durationSeconds,
      locale: String(body.locale ?? ''),
      userId: video.user_id,
      videoId: video.id,
    });

    if (!enhancedPrompt) {
      return new Response(
        JSON.stringify({
          success: false,
          errorCode: 'enhance_unavailable',
          error: 'Prompt enhancement is currently unavailable.',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, enhancedPrompt }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[enhance-prompt] Error:', err);
    // Surface the real error (e.g. context-size exceeded) so the UI can show
    // something actionable instead of a generic "unavailable".
    const friendly = /exceeds the available context|context size|n_ctx|exceed_context_size/i.test(message)
      ? '请求超出模型上下文窗口（参考图片/截图过多或过大）。请减少参考素材后重试。'
      : message;
    return new Response(
      JSON.stringify({ success: false, error: friendly }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
