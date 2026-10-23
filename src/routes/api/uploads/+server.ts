import type { RequestHandler } from '@sveltejs/kit';
import { createDraftFromUploadForm } from '$lib/uploadForm';
import { errorResponse, jsonResponse, serializeVideoDetail } from '$lib/agentApi';

/**
 * POST /api/uploads — create a draft (status `uploaded`) from reference media.
 *
 * multipart/form-data: the same fields as the /new form
 *   i2v:  mode=i2v (default), image
 *   fl2v: mode=fl2v, first_image, last_image
 *   ref2v: mode=ref2v, ref_image_1..6, ref_video | ref_video_url, ref_audio,
 *          ref_video_start, ref_video_end, ref_video_include_audio, ref_video_duration
 * application/json: only string/number/boolean fields (no files), e.g.
 *   {"mode":"ref2v","ref_video_url":"/media/..."}  (ref_video_url must be a /media/ path)
 *
 * Validation is shared with the web form (src/lib/uploadForm.ts).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return errorResponse(401, 'Authentication required', 'unauthenticated');

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  let form: FormData;
  try {
    if (contentType.startsWith('multipart/form-data')) {
      form = await request.formData();
    } else if (contentType.startsWith('application/json')) {
      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return errorResponse(400, 'JSON body must be an object', 'invalid_body');
      }
      form = new FormData();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') form.set(k, String(v));
      }
    } else {
      return errorResponse(415, 'Content-Type must be multipart/form-data or application/json', 'unsupported_media_type');
    }
  } catch {
    return errorResponse(400, 'Could not parse request body', 'invalid_body');
  }

  const result = await createDraftFromUploadForm(form, locals.user, { apiMode: true });
  if (!('success' in result)) {
    return errorResponse(400, result.error, 'upload_invalid');
  }
  const detail = serializeVideoDetail(result.entry);
  return jsonResponse({ success: true, id: detail.id, status: detail.status, mode: detail.mode, video: detail }, 201);
};
