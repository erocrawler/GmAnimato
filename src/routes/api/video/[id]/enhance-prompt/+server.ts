import type { RequestHandler } from '@sveltejs/kit';
import { getVideoById } from '$lib/db';
import { enhanceMiniMaxPrompt } from '$lib/imageRecognition';
import { toOriginalUrl } from '$lib/serverImageUrl';
import { extractVideoScreenshots } from '$lib/videoValidation';
import { uploadBufferToS3 } from '$lib/s3';

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

    const requestedType = String(body.workflowType ?? '');
    const workflowType: 'ref2v' | 'fl2v' | 'i2v' =
      requestedType === 'ref2v' || requestedType === 'fl2v' || requestedType === 'i2v'
        ? requestedType
        : video.additional_options?.ref2v === true
          ? 'ref2v'
          : video.last_image_url
            ? 'fl2v'
            : 'i2v';

    // Gather labeled reference images for vision grounding (convert proxied
    // /media/ URLs back to S3 URLs — the VL client fetches them server-side).
    // Each image gets a caption binding it to its <Picture N>/<Video 1> tag so
    // the VL model can tell which upload is which (it can't infer that from a
    // bare URL).
    const labeledImages: { label: string; url: string }[] = [];
    if (workflowType === 'ref2v') {
      // ref2v: reference images are <Picture N>; screenshots from the ref
      // video are <Video 1> 截图 N/M.
      const refImages: string[] = video.additional_options?.ref_image_urls ?? [];
      refImages.slice(0, 6).forEach((u, i) => {
        labeledImages.push({ label: `<Picture ${i + 1}>`, url: u });
      });

      const refVideoUrl = video.additional_options?.ref_video_url;
      if (refVideoUrl) {
        const screenshots = await extractVideoScreenshots(toOriginalUrl(refVideoUrl), 3);
        for (let i = 0; i < screenshots.length; i++) {
          try {
            const shotUrl = await uploadBufferToS3(screenshots[i], 'jpg');
            if (shotUrl) {
              labeledImages.push({
                label: `<Video 1> 截图 ${i + 1}/${screenshots.length}`,
                url: shotUrl,
              });
            }
          } catch (e) {
            console.warn('[enhance-prompt] Failed to upload ref-video screenshot:', e);
          }
        }
      }

      // Fall back to the poster frame if no refs at all (pure t2v).
      if (labeledImages.length === 0 && video.original_image_url) {
        labeledImages.push({ label: '主图像', url: video.original_image_url });
      }
    } else if (workflowType === 'fl2v') {
      if (video.original_image_url) labeledImages.push({ label: '首帧 (first frame)', url: video.original_image_url });
      if (video.last_image_url) labeledImages.push({ label: '尾帧 (last frame)', url: video.last_image_url });
    } else {
      if (video.original_image_url) labeledImages.push({ label: '主图像', url: video.original_image_url });
    }
    for (const item of labeledImages) {
      item.url = toOriginalUrl(item.url);
    }
    const filteredLabeled = labeledImages.filter((x) => x.url);

    const durationSeconds = Number(body.videoDuration ?? video.video_duration ?? 5);

    const enhancedPrompt = await enhanceMiniMaxPrompt({
      prompt,
      workflowType,
      labeledImages: filteredLabeled,
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
